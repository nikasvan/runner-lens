import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { collectSystemInfo } from './system-info';
import { parseConfig } from './config';
import {
  DATA_DIR, METRICS_FILE, PID_FILE, SYSINFO_FILE, START_TS_FILE, STATE,
} from './constants';

async function run(): Promise<void> {
  try {
    const cfg = parseConfig();

    // ── Summarize mode: skip collector, just enable post step ──
    if (cfg.mode === 'summarize') {
      core.saveState(STATE.ACTIVE, 'true');
      core.info('RunnerLens: summarize mode — skipping collector');
      return;
    }

    // ── Prepare workspace ─────────────────────────────────
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(START_TS_FILE, Date.now().toString());

    // ── Collect static system info ────────────────────────
    const sysInfo = await collectSystemInfo();
    fs.writeFileSync(SYSINFO_FILE, JSON.stringify(sysInfo));

    core.info(
      `RunnerLens: ${sysInfo.cpu_count} CPUs · ` +
      `${sysInfo.total_memory_mb} MB RAM · ` +
      `sampling every ${cfg.sampleInterval}s`,
    );

    // ── Resolve script path ───────────────────────────────
    // __dirname is dist/main/ after bundling → up two levels to action root
    const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'collect.sh');

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Collector script not found at ${scriptPath}`);
    }

    fs.chmodSync(scriptPath, 0o755);

    // ── Build arguments ───────────────────────────────────
    const args: string[] = [
      scriptPath,
      METRICS_FILE,
      cfg.sampleInterval.toString(),
      `--max-size=${cfg.maxSizeMb}`,
    ];

    // ── Spawn collector (detached, won't block the job) ───
    const child = spawn('sh', args, {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();

    if (!child.pid) {
      throw new Error('Collector process did not start');
    }

    fs.writeFileSync(PID_FILE, child.pid.toString());

    core.info(`RunnerLens: collector started (PID ${child.pid})`);

    // ── Persist state for the post step ───────────────────
    core.saveState(STATE.ACTIVE, 'true');
    core.saveState(STATE.DATA_DIR, DATA_DIR);
    core.saveState(STATE.PID, child.pid.toString());

  } catch (err) {
    // Never fail the user's workflow — monitoring is best-effort.
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`RunnerLens: failed to start monitoring — ${msg}`);
  }
}

run();
