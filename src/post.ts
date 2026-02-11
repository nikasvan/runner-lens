import * as core from '@actions/core';
import * as fs from 'fs';
import type { MetricSample, SystemInfo } from './types';
import { parseConfig } from './config';
import { processMetrics } from './reporter';
import { sendToApi } from './api-client';
import { safePct } from './stats';
import {
  DATA_DIR, METRICS_FILE, PID_FILE, SYSINFO_FILE, START_TS_FILE, STATE,
} from './constants';
import * as os from 'os';

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
  try {
    if (core.getState(STATE.ACTIVE) !== 'true') {
      core.info('RunnerLens: monitoring was not active — nothing to report');
      return;
    }

    // ── Stop collector & flush ────────────────────────────
    stopCollector();
    await new Promise((r) => setTimeout(r, 1200));

    // ── Load data ─────────────────────────────────────────
    const samples = loadSamples();
    const sysInfo = loadSystemInfo();
    const config  = parseConfig();

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

    // ── Process ───────────────────────────────────────────
    const { report, markdown } = processMetrics(samples, sysInfo, config, dur);

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

    // ── Job Summary ───────────────────────────────────────
    if (markdown) {
      await core.summary.addRaw(markdown).write();
      core.info('RunnerLens: report written to Job Summary');
    }

    // ── API upload ────────────────────────────────────────
    if (config.apiKey) {
      await sendToApi(config, sysInfo, report, samples);
    }

    // ── Log alerts ────────────────────────────────────────
    for (const a of report.alerts) {
      if (a.level === 'critical')     core.error(`RunnerLens: ${a.message}`);
      else if (a.level === 'warning') core.warning(`RunnerLens: ${a.message}`);
      else                            core.notice(`RunnerLens: ${a.message}`);
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
