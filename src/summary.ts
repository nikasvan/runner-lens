// ─────────────────────────────────────────────────────────────
// RunnerLens — Workflow-Level Summary (Summarize Mode)
//
// Aggregates report.json artifacts from all monitored jobs in
// the current workflow run into a single unified summary.
// ─────────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DefaultArtifactClient } from '@actions/artifact';
import type {
  MonitorConfig, AggregatedReport, JobReport, SystemInfo, ProcessInfo,
} from './types';
import { stats, safeMax } from './stats';
import { buildJobSummary } from './job-summary';
import { REPORT_VERSION } from './constants';

// ─────────────────────────────────────────────────────────────
// Helpers (exported for testing)
// ─────────────────────────────────────────────────────────────

export function fingerprint(sys: SystemInfo): string {
  // Group by core count + OS + arch.  This correctly buckets GitHub hosted
  // runner tiers (2-core standard vs 4/8/16-core larger runners) without
  // splitting on cpu_model or total_memory_mb, which can vary across VMs
  // in the same fleet even for the same runs-on label.
  return `${sys.cpu_count}|${sys.runner_os}|${sys.runner_arch}`;
}

export function mergeReports(jobReports: JobReport[]): AggregatedReport {
  // Sort chronologically by started_at
  const sorted = [...jobReports].sort(
    (a, b) => new Date(a.report.started_at).getTime() - new Date(b.report.started_at).getTime(),
  );

  const first = sorted[0].report;

  // Time range: earliest started_at → latest ended_at
  const startedAt = first.started_at;
  const allEndTimes = sorted.map((j) => new Date(j.report.ended_at).getTime());
  const endedAt = new Date(Math.max(...allEndTimes)).toISOString();

  // Duration: max of any individual job (jobs run in parallel)
  const durationSeconds = Math.max(...sorted.map((j) => j.report.duration_seconds));

  // Merge timelines: concatenate in chronological order
  const cpuTimeline: number[] = [];
  const memTimeline: number[] = [];
  for (const jr of sorted) {
    if (jr.report.timeline) {
      cpuTimeline.push(...jr.report.timeline.cpu_pct);
      memTimeline.push(...jr.report.timeline.mem_mb);
    }
  }

  // Recompute stats from merged timeline values
  const cpuStats = cpuTimeline.length > 0
    ? stats(cpuTimeline)
    : stats(sorted.flatMap((j) => [j.report.cpu.avg]));
  const memStats = memTimeline.length > 0
    ? stats(memTimeline)
    : stats(sorted.flatMap((j) => [j.report.memory.avg]));

  // Sample count: sum of all
  const sampleCount = sorted.reduce((sum, j) => sum + j.report.sample_count, 0);

  // Steps: collect from all jobs
  const allSteps = sorted.flatMap((j) => j.report.steps ?? []);

  // Top processes: merge, deduplicate by name keeping highest CPU, top 10
  const procMap = new Map<string, ProcessInfo>();
  for (const jr of sorted) {
    for (const p of jr.report.top_processes) {
      const cur = procMap.get(p.name);
      if (!cur || p.cpu_pct > cur.cpu_pct) procMap.set(p.name, p);
    }
  }
  const topProcesses = [...procMap.values()]
    .sort((a, b) => b.cpu_pct - a.cpu_pct)
    .slice(0, 10);

  // Load: weighted average for avg, max across all
  const loadAvg = sampleCount > 0
    ? sorted.reduce((s, j) => s + j.report.load.avg_1m * j.report.sample_count, 0) / sampleCount
    : 0;
  const loadMax = safeMax(sorted.map((j) => j.report.load.max_1m));

  // Memory total & swap: take from first report (same hardware in group)
  const memTotalMb = first.memory.total_mb;
  const swapMaxMb = safeMax(sorted.map((j) => j.report.memory.swap_max_mb));

  // System info: take from first report (all identical in same group)
  const system = first.system;

  const report: AggregatedReport = {
    version: REPORT_VERSION,
    system,
    duration_seconds: durationSeconds,
    sample_count: sampleCount,
    started_at: startedAt,
    ended_at: endedAt,
    cpu: cpuStats,
    memory: { ...memStats, total_mb: memTotalMb, swap_max_mb: swapMaxMb },
    load: { avg_1m: loadAvg, max_1m: loadMax },
    top_processes: topProcesses,
    ...(allSteps.length > 0 ? { steps: allSteps } : {}),
    ...(cpuTimeline.length >= 2 ? { timeline: { cpu_pct: cpuTimeline, mem_mb: memTimeline } } : {}),
  };

  return report;
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function runSummary(_config: MonitorConfig): Promise<void> {
  const artifact = new DefaultArtifactClient();
  const tempDir = path.join(os.tmpdir(), 'runnerlens-summary');

  try {
    // ── List artifacts for current run ──────────────────────
    const { artifacts } = await artifact.listArtifacts({ latest: true });
    const rlArtifacts = artifacts.filter((a) =>
      a.name.startsWith('runner-lens-') && a.name !== 'runner-lens-summary',
    );

    if (rlArtifacts.length === 0) {
      core.warning('RunnerLens: no runner-lens-* artifacts found — nothing to summarize');
      return;
    }

    core.info(`RunnerLens: found ${rlArtifacts.length} runner-lens artifact(s)`);

    // ── Download & parse each report ───────────────────────
    const jobReports: JobReport[] = [];
    for (const art of rlArtifacts) {
      try {
        const dlDir = path.join(tempDir, art.name);
        fs.mkdirSync(dlDir, { recursive: true });
        const { downloadPath } = await artifact.downloadArtifact(art.id, { path: dlDir });
        const reportPath = path.join(downloadPath ?? dlDir, 'report.json');

        if (!fs.existsSync(reportPath)) {
          core.warning(`RunnerLens: no report.json in artifact "${art.name}" — skipping`);
          continue;
        }

        const report: AggregatedReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        const jobName = art.name.replace(/^runner-lens-/, '');
        jobReports.push({ jobName, report });
        core.info(`RunnerLens: loaded report from "${art.name}" (${report.sample_count} samples)`);
      } catch (e) {
        core.warning(`RunnerLens: failed to download/parse artifact "${art.name}" — ${e}`);
      }
    }

    if (jobReports.length === 0) {
      core.warning('RunnerLens: no valid reports found — nothing to summarize');
      return;
    }

    // ── Group by runner fingerprint ────────────────────────
    const groups = new Map<string, JobReport[]>();
    for (const jr of jobReports) {
      const fp = fingerprint(jr.report.system);
      const group = groups.get(fp) ?? [];
      group.push(jr);
      groups.set(fp, group);
    }

    core.info(`RunnerLens: ${jobReports.length} job(s) in ${groups.size} runner group(s)`);

    // ── Generate summary for each group ────────────────────
    const summaryParts: string[] = [];
    for (const [, groupJobs] of groups) {
      const merged = mergeReports(groupJobs);
      const html = await buildJobSummary(merged, groupJobs);
      summaryParts.push(html);
    }

    await core.summary.addRaw(summaryParts.join('\n\n---\n\n')).write();
    core.info('RunnerLens: unified summary written');

    // ── Upload merged report artifact ──────────────────────
    try {
      const allReports = [...groups.values()].map((groupJobs) => mergeReports(groupJobs));
      const mergedPath = path.join(tempDir, 'report.json');
      fs.writeFileSync(mergedPath, JSON.stringify(
        allReports.length === 1 ? allReports[0] : allReports,
        null,
        2,
      ));
      await artifact.uploadArtifact('runner-lens-summary', [mergedPath], tempDir);
      core.info('RunnerLens: uploaded merged artifact "runner-lens-summary"');
    } catch (e) {
      core.debug(`RunnerLens: merged artifact upload failed — ${e}`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`RunnerLens: summarize failed — ${msg}`);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
