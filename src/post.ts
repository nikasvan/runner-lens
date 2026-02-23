import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DefaultArtifactClient } from '@actions/artifact';
import type { MetricSample, SystemInfo, StepMetrics } from './types';
import { parseConfig } from './config';
import { processMetrics, buildJobMarkdown } from './reporter';
import { uploadChartSvgs } from './svg-upload';
import { sendToApi } from './api-client';
import { safePct } from './stats';
import { fetchSteps, correlateSteps } from './steps';
import { runSummary } from './summary';
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
    const { report, charts, chartUrls } = processMetrics(samples, sysInfo, config, dur, steps);

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

    // ── Upload SVG charts (primary) or fall back to quickchart URLs ──
    let urls: Record<string, string> = {};
    if (config.githubToken && Object.keys(charts).length > 0) {
      urls = await uploadChartSvgs(charts, config.githubToken);
    }
    // Fall back to quickchart.io URLs when SVG upload unavailable
    if (Object.keys(urls).length === 0) {
      urls = chartUrls;
    }
    const markdown = buildJobMarkdown(report, samples, config, urls);

    if (markdown) {
      await core.summary.addRaw(markdown).write();
      core.info('RunnerLens: report written to Job Summary');
    }

    // ── API upload ────────────────────────────────────────
    if (config.apiKey) {
      await sendToApi(config, report, samples);
    }

    // ── Artifact upload ─────────────────────────────────
    // Always upload report.json so summarize mode can aggregate.
    // The upload-artifact flag controls whether the larger samples.json is included.
    {
      try {
        const jobName = process.env.GITHUB_JOB ?? 'unknown';
        const artifactName = `runner-lens-${jobName}`;
        const artifactDir = path.join(DATA_DIR, 'artifact');
        fs.mkdirSync(artifactDir, { recursive: true });

        const reportFile = path.join(artifactDir, 'report.json');
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

        const files = [reportFile];
        if (core.getInput('upload-artifact') === 'true') {
          const samplesFile = path.join(artifactDir, 'samples.json');
          fs.writeFileSync(samplesFile, JSON.stringify(samples, null, 2));
          files.push(samplesFile);
        }

        const artifact = new DefaultArtifactClient();
        await artifact.uploadArtifact(artifactName, files, artifactDir);
        core.info(`RunnerLens: report uploaded as artifact "${artifactName}"`);
      } catch (e) {
        core.warning(`RunnerLens: artifact upload failed — ${e}`);
      }
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
