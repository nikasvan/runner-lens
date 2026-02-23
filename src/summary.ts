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
import { workflowTimelineChart, waterfallChart, statCards, svgImg } from './svg-charts';
import type { TimelineSegment, WaterfallStep } from './svg-charts';
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

      const summaryPath = path.join(downloadPath, 'summary.md');
      const summaryMd = fs.existsSync(summaryPath)
        ? fs.readFileSync(summaryPath, 'utf-8')
        : undefined;

      jobs.push({ jobName, report, summaryMd });
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
  const cardsSvg = statCards([
    { label: 'Runner', value: `${sys.cpu_count} × ${sys.cpu_model}`, sub: `${(sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${sys.runner_os}`, colorVar: 'muted' },
    { label: 'Duration', value: fmtDuration(totalDuration), sub: jobLabel, colorVar: 'accent-cyan' },
    { label: 'Avg CPU', value: `${weightedCpuAvg.toFixed(0)}%`, sub: `peak ${cpuPeak.toFixed(0)}%`, colorVar: 'accent-blue' },
    { label: 'Memory', value: `${memAvgPct.toFixed(0)}% avg`, sub: `peak ${memPeakPct.toFixed(0)}% · ${(memPeak / 1024).toFixed(1)} GB`, colorVar: 'accent-purple' },
  ]);
  L.push(svgImg(cardsSvg, 'Summary stats', 600) + '\n');

  // ── Sort jobs chronologically for timeline ──────────────
  const sorted = [...jobs].sort((a, b) =>
    new Date(a.report.started_at).getTime() - new Date(b.report.started_at).getTime(),
  );

  // ── CPU Timeline Chart ──────────────────────────────────
  const cpuSegments: TimelineSegment[] = sorted
    .filter(j => j.report.timeline)
    .map(j => ({ label: j.jobName, values: j.report.timeline!.cpu_pct, startedAt: j.report.started_at, endedAt: j.report.ended_at }));

  if (cpuSegments.length > 0) {
    const cpuSvg = workflowTimelineChart(cpuSegments, {
      color: 'cpu-stroke',
      fillColor: 'cpu-fill',
      yMax: 100,
      yFormat: (v) => `${v.toFixed(0)}%`,
      title: 'CPU Usage',
    });
    if (cpuSvg) {
      L.push('### CPU Usage\n');
      L.push(svgImg(cpuSvg, 'CPU usage timeline', 600) + '\n');
    }
  }

  // ── Memory Timeline Chart ───────────────────────────────
  const memSegments: TimelineSegment[] = sorted
    .filter(j => j.report.timeline)
    .map(j => ({ label: j.jobName, values: j.report.timeline!.mem_mb, startedAt: j.report.started_at, endedAt: j.report.ended_at }));

  if (memSegments.length > 0) {
    const memSvg = workflowTimelineChart(memSegments, {
      color: 'mem-stroke',
      fillColor: 'mem-fill',
      yMax: totalMb,
      yFormat: (v) => `${(v / 1024).toFixed(1)} GB`,
      title: 'Memory Usage',
    });
    if (memSvg) {
      L.push('### Memory Usage\n');
      L.push(svgImg(memSvg, 'Memory usage timeline', 600) + '\n');
    }
  }

  // ── Execution Timeline (Waterfall Chart) ────────────────
  const hasSteps = sorted.some(j => j.report.steps && j.report.steps.length > 0);
  if (hasSteps) {
    // Compute absolute start times for each step
    const workflowStart = Math.min(...sorted.map(j => new Date(j.report.started_at).getTime()));
    const wfSteps: WaterfallStep[] = [];
    for (const j of sorted) {
      if (!j.report.steps) continue;
      const jobOffset = (new Date(j.report.started_at).getTime() - workflowStart) / 1000;
      let cumSec = 0;
      for (const s of j.report.steps) {
        wfSteps.push({
          label: `${j.jobName} · ${s.name}`,
          startSec: jobOffset + cumSec,
          durationSec: s.duration_seconds,
          group: j.jobName,
        });
        cumSec += s.duration_seconds;
      }
    }

    const wfSvg = waterfallChart(wfSteps, {
      title: 'Execution Timeline',
      formatDuration: fmtDuration,
    });
    if (wfSvg) {
      L.push('### Execution Timeline\n');
      L.push(svgImg(wfSvg, 'Execution timeline', 600) + '\n');
    }
  }

  // ── Per-Job Details (from uploaded summaries) ──────────
  const jobsWithSummary = sorted.filter(j => j.summaryMd);
  if (jobsWithSummary.length > 0) {
    L.push('### Per-Job Details\n');
    for (const j of jobsWithSummary) {
      L.push(`<details><summary><strong>${escapeHtml(j.jobName)}</strong></summary>\n`);
      L.push(j.summaryMd!);
      L.push('\n</details>\n');
    }
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
