// ─────────────────────────────────────────────────────────────
// RunnerLens — Workflow-Level Summary
// ─────────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { DefaultArtifactClient } from '@actions/artifact';
import type { MonitorConfig, JobReport, AggregatedReport } from './types';
import { safePct } from './stats';
import { fmtDuration } from './charts';
import { htmlStatCards, htmlTimeline, htmlWaterfall } from './html-charts';
import { REPORT_VERSION } from './constants';

// ─────────────────────────────────────────────────────────────
// Download & parse job reports from artifacts
// ─────────────────────────────────────────────────────────────

const ARTIFACT_PREFIX = 'runner-lens-';

export async function downloadJobReports(): Promise<JobReport[]> {
  const artifact = new DefaultArtifactClient();

  const { artifacts } = await artifact.listArtifacts({ latest: true });
  const matching = artifacts.filter((a) => a.name.startsWith(ARTIFACT_PREFIX));

  if (matching.length === 0) return [];

  const jobs: JobReport[] = [];
  for (const art of matching) {
    try {
      const { downloadPath } = await artifact.downloadArtifact(art.id);
      if (!downloadPath) continue;

      const reportPath = path.join(downloadPath, 'report.json');
      if (!fs.existsSync(reportPath)) continue;

      const report: AggregatedReport = JSON.parse(
        fs.readFileSync(reportPath, 'utf-8'),
      );
      const jobName = art.name.slice(ARTIFACT_PREFIX.length);
      jobs.push({ jobName, report });
    } catch (e) {
      core.warning(`RunnerLens: failed to download artifact "${art.name}" — ${e}`);
    }
  }

  jobs.sort((a, b) => a.jobName.localeCompare(b.jobName));
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Render workflow-level markdown
// ─────────────────────────────────────────────────────────────

export function workflowMarkdown(jobs: JobReport[], _config?: MonitorConfig): string {
  const L: string[] = [];

  const totalDuration = jobs.reduce((s, j) => s + j.report.duration_seconds, 0);
  const totalSamples = jobs.reduce((s, j) => s + j.report.sample_count, 0);

  // ── Runner info (from first job) ────────────────────────
  const sys = jobs[0].report.system;
  L.push('## 📊 RunnerLens — Workflow Summary\n');

  // ── Aggregate stats ─────────────────────────────────────
  const weightedCpuAvg = totalSamples > 0
    ? jobs.reduce((s, j) => s + j.report.cpu.avg * j.report.sample_count, 0) / totalSamples
    : 0;
  const weightedMemAvg = totalSamples > 0
    ? jobs.reduce((s, j) => s + j.report.memory.avg * j.report.sample_count, 0) / totalSamples
    : 0;
  const cpuPeak = Math.max(...jobs.map((j) => j.report.cpu.max));
  const memPeak = Math.max(...jobs.map((j) => j.report.memory.max));
  const totalMb = sys.total_memory_mb;

  // ── Stat cards ──────────────────────────────────────────
  const memAvgPct = safePct(weightedMemAvg, totalMb);
  const memPeakPct = safePct(memPeak, totalMb);
  const jobLabel = `${jobs.length} job${jobs.length !== 1 ? 's' : ''}`;
  L.push(htmlStatCards([
    { label: 'Runner', value: `${sys.cpu_count} × ${sys.cpu_model}`, sub: `${(sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${sys.runner_os}` },
    { label: 'Duration', value: fmtDuration(totalDuration), sub: jobLabel },
    { label: 'Avg CPU', value: `${weightedCpuAvg.toFixed(0)}%`, sub: `peak ${cpuPeak.toFixed(0)}%` },
    { label: 'Memory', value: `${memAvgPct.toFixed(0)}% avg`, sub: `peak ${memPeakPct.toFixed(0)}% · ${(memPeak / 1024).toFixed(1)} GB` },
  ]) + '\n');

  // ── Sort jobs chronologically for timeline ──────────────
  const sorted = [...jobs].sort((a, b) =>
    new Date(a.report.started_at).getTime() - new Date(b.report.started_at).getTime(),
  );

  // ── CPU & Memory Timeline Sparklines ───────────────────
  const cpuSegments = sorted.filter(j => j.report.timeline).flatMap(j => j.report.timeline!.cpu_pct);
  const memSegments = sorted.filter(j => j.report.timeline).flatMap(j => j.report.timeline!.mem_mb);

  if (cpuSegments.length >= 2 || memSegments.length >= 2) {
    const rows = [];
    if (cpuSegments.length >= 2) {
      rows.push({ label: 'CPU', values: cpuSegments, avg: `${weightedCpuAvg.toFixed(0)}% avg` });
    }
    if (memSegments.length >= 2) {
      const memPctValues = memSegments.map(v => totalMb > 0 ? (v / totalMb) * 100 : 0);
      rows.push({ label: 'Memory', values: memPctValues, avg: `${memAvgPct.toFixed(0)}% avg` });
    }
    L.push('### Timeline\n');
    L.push(htmlTimeline(rows) + '\n');
  }

  // ── Execution Timeline (Waterfall) ─────────────────────
  const hasSteps = sorted.some(j => j.report.steps && j.report.steps.length > 0);
  if (hasSteps) {
    const workflowStart = Math.min(...sorted.map(j => new Date(j.report.started_at).getTime()));
    const wfRows = [];
    for (const j of sorted) {
      if (!j.report.steps) continue;
      const jobOffset = (new Date(j.report.started_at).getTime() - workflowStart) / 1000;
      let cumSec = 0;
      for (const s of j.report.steps) {
        wfRows.push({
          job: j.jobName,
          step: s.name,
          startSec: jobOffset + cumSec,
          durationSec: s.duration_seconds,
        });
        cumSec += s.duration_seconds;
      }
    }

    L.push('### Execution Timeline\n');
    L.push(htmlWaterfall(wfRows) + '\n');
  }

  // ── Footer ─────────────────────────────────────────────
  L.push('---');
  L.push(
    `<sub><a href="https://runnerlens.com">RunnerLens</a> ` +
    `v${REPORT_VERSION} — Workflow Summary</sub>`,
  );

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function runSummary(config: MonitorConfig): Promise<void> {
  core.info('RunnerLens: summarize mode — downloading job reports');

  const jobs = await downloadJobReports();

  if (jobs.length === 0) {
    core.warning(
      'RunnerLens: no job reports found. Ensure monitored jobs run before the summary job ' +
      'and use runner-lens with mode: monitor (the default).',
    );
    return;
  }

  core.info(`RunnerLens: found ${jobs.length} job report(s): ${jobs.map((j) => j.jobName).join(', ')}`);

  const md = workflowMarkdown(jobs, config);
  await core.summary.addRaw(md).write();
  core.info('RunnerLens: workflow summary written to Job Summary');

  // ── Set aggregate outputs ─────────────────────────────
  const totalDuration = jobs.reduce((s, j) => s + j.report.duration_seconds, 0);
  const maxCpu = Math.max(...jobs.map((j) => j.report.cpu.max));
  const totalSamples = jobs.reduce((s, j) => s + j.report.sample_count, 0);

  core.setOutput('duration-seconds', totalDuration.toString());
  core.setOutput('cpu-max', maxCpu.toFixed(1));
  core.setOutput('samples', totalSamples.toString());
}
