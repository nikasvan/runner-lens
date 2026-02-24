import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DefaultArtifactClient } from '@actions/artifact';
import type { MetricSample, SystemInfo, StepMetrics, AggregatedReport, JobReport } from './types';
import { parseConfig } from './config';
import { processMetrics } from './reporter';
import { safePct } from './stats';
import { fetchSteps, correlateSteps, isLastJob } from './steps';
import { runSummary, fingerprint, mergeReports } from './summary';
import { buildJobSummary } from './job-summary';
import {
  DATA_DIR, METRICS_FILE, PID_FILE, SYSINFO_FILE, START_TS_FILE, STATE,
} from './constants';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function stopCollector(): void {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (pid > 0) {
      // Kill the entire process group (collector + child awk/ps/df).
      // The collector is spawned with { detached: true } so it's a
      // process group leader and -pid targets the whole group.
      try { process.kill(-pid, 'SIGTERM'); } catch {
        // If group kill fails (e.g. not a group leader), fall back to
        // killing just the parent process.
        try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
      }
      core.info(`RunnerLens: collector stopped (PID ${pid})`);
    }
  } catch (e) {
    core.debug(`RunnerLens: stop error — ${e}`);
  }
}

/**
 * Load JSONL samples from the metrics file AND the rotated .1 file.
 *
 * The v2 collector rotates metrics.jsonl → metrics.jsonl.1 when it
 * exceeds --max-size. We read .1 first (older data) then the main
 * file (newer data) so samples are in chronological order.
 */
function loadSamples(): MetricSample[] {
  const files = [`${METRICS_FILE}.1`, METRICS_FILE].filter((f) =>
    fs.existsSync(f),
  );

  const samples: MetricSample[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content) continue;
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        samples.push(JSON.parse(line));
      } catch {
        /* skip malformed lines */
      }
    }
  }

  // Ensure chronological order (rotation could cause minor overlap)
  samples.sort((a, b) => a.timestamp - b.timestamp);
  return samples;
}

function loadSystemInfo(): SystemInfo {
  try {
    if (fs.existsSync(SYSINFO_FILE))
      return JSON.parse(fs.readFileSync(SYSINFO_FILE, 'utf-8'));
  } catch { /* fallback */ }
  return {
    cpu_count: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    os_release: 'unknown', kernel: 'unknown',
    runner_name: process.env.RUNNER_NAME ?? 'unknown',
    runner_os: process.env.RUNNER_OS ?? 'unknown',
    runner_arch: process.env.RUNNER_ARCH ?? 'unknown',
  };
}

/**
 * Download report.json from runner-lens artifacts uploaded by
 * sibling jobs that already finished.
 */
async function downloadPeerReports(ownJobName: string): Promise<JobReport[]> {
  const artClient = new DefaultArtifactClient();
  const { artifacts } = await artClient.listArtifacts({ latest: true });
  const peers = artifacts.filter((a) =>
    a.name.startsWith('runner-lens-') &&
    a.name !== 'runner-lens-summary' &&
    a.name !== `runner-lens-${ownJobName}`,
  );

  if (peers.length === 0) return [];

  const tmpDir = path.join(os.tmpdir(), 'runnerlens-peers');
  const reports: JobReport[] = [];

  try {
    for (const art of peers) {
      try {
        const dlDir = path.join(tmpDir, art.name);
        fs.mkdirSync(dlDir, { recursive: true });
        const { downloadPath } = await artClient.downloadArtifact(art.id, { path: dlDir });
        const reportPath = path.join(downloadPath ?? dlDir, 'report.json');
        if (fs.existsSync(reportPath)) {
          const r: AggregatedReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
          reports.push({ jobName: art.name.replace(/^runner-lens-/, ''), report: r });
        }
      } catch { /* skip individual failures */ }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  return reports;
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cpuStart = process.cpuUsage();

  try {
    if (core.getState(STATE.ACTIVE) !== 'true') {
      core.info('RunnerLens: monitoring was not active — nothing to report');
      return;
    }

    const config  = parseConfig();

    // ── Summarize mode: aggregate reports from all jobs ───
    if (config.mode === 'summarize') {
      await runSummary(config);
      return;
    }

    // ── Stop collector & flush ────────────────────────────
    stopCollector();
    await new Promise((r) => setTimeout(r, 1200));

    // ── Load data ─────────────────────────────────────────
    const samples = loadSamples();
    const sysInfo = loadSystemInfo();

    if (samples.length === 0) {
      core.warning('RunnerLens: no samples collected');
      return;
    }

    // ── Duration ──────────────────────────────────────────
    let startTs = Date.now();
    try {
      if (fs.existsSync(START_TS_FILE))
        startTs = parseInt(fs.readFileSync(START_TS_FILE, 'utf-8').trim(), 10);
    } catch { /* ok */ }
    const dur = Math.round((Date.now() - startTs) / 1000);

    core.info(`RunnerLens: ${samples.length} samples over ${dur}s`);

    // ── Fetch per-step data (needs actions:read permission) ──
    let steps: StepMetrics[] | undefined;
    if (config.githubToken) {
      try {
        const rawSteps = await fetchSteps(config.githubToken);
        if (rawSteps.length > 0) {
          steps = correlateSteps(rawSteps, samples);
          core.info(`RunnerLens: correlated ${steps.length} steps`);
        }
      } catch (e) {
        core.debug(`RunnerLens: step fetch failed — ${e}`);
      }
    }

    // ── Process ───────────────────────────────────────────
    const { report } = processMetrics(samples, sysInfo, config, dur, steps);

    // ── Reporter self-monitoring ──────────────────────────
    // Use total job duration as denominator so the % is directly
    // comparable to the sampling overhead (both = fraction of one
    // core over the entire job).
    const cpuDelta = process.cpuUsage(cpuStart);
    const cpuSec = (cpuDelta.user + cpuDelta.system) / 1e6;
    const reporterCpuPct = dur > 0 ? (cpuSec / dur) * 100 : 0;
    const reporterMemMb = process.memoryUsage().rss / (1024 * 1024);
    report.reporter = { cpu_pct: reporterCpuPct, mem_mb: reporterMemMb };

    // ── Outputs ───────────────────────────────────────────
    core.setOutput('cpu-avg', report.cpu.avg.toFixed(1));
    core.setOutput('cpu-max', report.cpu.max.toFixed(1));
    core.setOutput('cpu-p95', report.cpu.p95.toFixed(1));
    core.setOutput('mem-avg-mb', report.memory.avg.toFixed(0));
    core.setOutput('mem-max-mb', report.memory.max.toFixed(0));
    core.setOutput('mem-avg-pct',
      safePct(report.memory.avg, report.memory.total_mb).toFixed(1));
    core.setOutput('samples', report.sample_count.toString());
    core.setOutput('duration-seconds', dur.toString());
    core.setOutput('report-json', JSON.stringify(report));

    // ── Upload report artifact (opt-in) ────────────────
    const jobName = process.env.GITHUB_JOB || 'job';
    if (core.getInput('upload-artifact').toLowerCase() === 'true') {
      try {
        const artifactName = `runner-lens-${jobName}`;
        const reportFile = path.join(DATA_DIR, 'report.json');
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        const artClient = new DefaultArtifactClient();
        await artClient.uploadArtifact(artifactName, [reportFile], DATA_DIR);
        core.info(`RunnerLens: uploaded artifact "${artifactName}"`);
      } catch (e) {
        core.debug(`RunnerLens: artifact upload failed — ${e}`);
      }
    }

    // ── Job Summary (automatic unified or individual) ──
    // Check if this is the last running job in the workflow.
    // If yes: download peer artifacts and write a unified summary.
    // If no:  skip — the last job to finish will write it.
    // Fallback: if we can't determine (no token / API error),
    // write an individual summary so the user always sees something.
    try {
      let lastJob = true;
      if (config.githubToken) {
        try {
          lastJob = await isLastJob(config.githubToken);
        } catch {
          lastJob = true; // can't check — write individual
        }
      }

      if (!lastJob) {
        core.info('RunnerLens: other jobs still running — deferring summary');
      } else {
        // Try to build unified summary with peer reports
        let summaryHtml: string;
        const peerJobs = await downloadPeerReports(jobName);
        const myFp = fingerprint(sysInfo);
        const matching = peerJobs.filter((jr) => fingerprint(jr.report.system) === myFp);

        if (matching.length > 0) {
          const allJobs: JobReport[] = [...matching, { jobName, report }];
          const merged = mergeReports(allJobs);
          summaryHtml = await buildJobSummary(merged, allJobs);
          core.info(`RunnerLens: unified summary with ${allJobs.length} job(s)`);
        } else {
          summaryHtml = await buildJobSummary(report);
        }

        await core.summary.addRaw(summaryHtml).write();
      }
    } catch (e) {
      core.debug(`RunnerLens: job summary failed — ${e}`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`RunnerLens: report failed — ${msg}`);
  } finally {
    // ── Cleanup temp files (including rotated .1) ─────────
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

run();
