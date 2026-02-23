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
import {
  svgImg, statCards, workflowTimelineChart, waterfallChart,
  type TimelineSegment,
} from './svg-charts';
import { htmlStatCards, htmlTimeline, htmlWaterfall } from './html-charts';
import { statCardChartUrl, waterfallChartUrl, workflowTimelineUrl } from './quickchart';
import { uploadChartSvgs } from './svg-upload';
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
// Helpers shared by SVG and fallback rendering
// ─────────────────────────────────────────────────────────────

function aggregateStats(jobs: JobReport[]) {
  const totalDuration = jobs.reduce((s, j) => s + j.report.duration_seconds, 0);
  const totalSamples = jobs.reduce((s, j) => s + j.report.sample_count, 0);
  const sys = jobs[0].report.system;

  const weightedCpuAvg = totalSamples > 0
    ? jobs.reduce((s, j) => s + j.report.cpu.avg * j.report.sample_count, 0) / totalSamples
    : 0;
  const weightedMemAvg = totalSamples > 0
    ? jobs.reduce((s, j) => s + j.report.memory.avg * j.report.sample_count, 0) / totalSamples
    : 0;
  const cpuPeak = Math.max(...jobs.map((j) => j.report.cpu.max));
  const memPeak = Math.max(...jobs.map((j) => j.report.memory.max));
  const totalMb = sys.total_memory_mb;
  const memAvgPct = safePct(weightedMemAvg, totalMb);
  const memPeakPct = safePct(memPeak, totalMb);
  const jobLabel = `${jobs.length} job${jobs.length !== 1 ? 's' : ''}`;

  return {
    totalDuration, totalSamples, sys,
    weightedCpuAvg, weightedMemAvg, cpuPeak, memPeak,
    totalMb, memAvgPct, memPeakPct, jobLabel,
  };
}

// ─────────────────────────────────────────────────────────────
// Chart generation for workflow summary
// ─────────────────────────────────────────────────────────────

/** Shared data used by both SVG and quickchart generators. */
function sortedJobs(jobs: JobReport[]) {
  return [...jobs].sort((x, y) =>
    new Date(x.report.started_at).getTime() - new Date(y.report.started_at).getTime(),
  );
}

function buildWaterfallSteps(sorted: JobReport[]) {
  const hasSteps = sorted.some(j => j.report.steps && j.report.steps.length > 0);
  if (!hasSteps) return [];
  const workflowStart = Math.min(...sorted.map(j => new Date(j.report.started_at).getTime()));
  const wfSteps: Array<{ job: string; step: string; startSec: number; durationSec: number }> = [];
  for (const j of sorted) {
    if (!j.report.steps) continue;
    const jobOffset = (new Date(j.report.started_at).getTime() - workflowStart) / 1000;
    let cumSec = 0;
    for (const s of j.report.steps) {
      wfSteps.push({ job: j.jobName, step: s.name, startSec: jobOffset + cumSec, durationSec: s.duration_seconds });
      cumSec += s.duration_seconds;
    }
  }
  return wfSteps;
}

/** Generate SVG chart strings for upload. */
export function generateWorkflowSvgs(jobs: JobReport[]): Record<string, string> {
  const charts: Record<string, string> = {};
  const a = aggregateStats(jobs);
  const sorted = sortedJobs(jobs);

  // Stat cards
  charts['stat-cards'] = svgImg(statCards([
    { label: 'Runner', value: `${a.sys.cpu_count} × ${a.sys.cpu_model}`, sub: `${(a.sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${a.sys.runner_os}`, colorVar: 'accent-cyan' },
    { label: 'Duration', value: fmtDuration(a.totalDuration), sub: a.jobLabel, colorVar: 'accent-green' },
    { label: 'Avg CPU', value: `${a.weightedCpuAvg.toFixed(0)}%`, sub: `peak ${a.cpuPeak.toFixed(0)}%`, colorVar: 'accent-blue' },
    { label: 'Memory', value: `${a.memAvgPct.toFixed(0)}% avg`, sub: `peak ${a.memPeakPct.toFixed(0)}% · ${(a.memPeak / 1024).toFixed(1)} GB`, colorVar: 'accent-purple' },
  ]), 'Workflow stats');

  // CPU timeline
  const cpuSegments: TimelineSegment[] = sorted
    .filter(j => j.report.timeline)
    .map(j => ({ label: j.jobName, values: j.report.timeline!.cpu_pct, startedAt: j.report.started_at, endedAt: j.report.ended_at }));

  if (cpuSegments.length > 0) {
    const svg = workflowTimelineChart(cpuSegments, {
      color: 'cpu-stroke', fillColor: 'cpu-fill', yMax: 100,
      yFormat: (v) => `${v.toFixed(0)}%`, title: 'CPU Usage',
    });
    if (svg) charts['cpu-timeline'] = svgImg(svg, 'CPU Timeline');
  }

  // Memory timeline
  const memSegments: TimelineSegment[] = sorted
    .filter(j => j.report.timeline)
    .map(j => ({ label: j.jobName, values: j.report.timeline!.mem_mb, startedAt: j.report.started_at, endedAt: j.report.ended_at }));

  if (memSegments.length > 0) {
    const svg = workflowTimelineChart(memSegments, {
      color: 'mem-stroke', fillColor: 'mem-fill', yMax: a.totalMb,
      yFormat: (v) => `${(v / 1024).toFixed(1)} GB`, title: 'Memory Usage',
    });
    if (svg) charts['mem-timeline'] = svgImg(svg, 'Memory Timeline');
  }

  // Execution waterfall
  const wfSteps = buildWaterfallSteps(sorted);
  if (wfSteps.length > 0) {
    const svg = waterfallChart(wfSteps.map(s => ({
      label: s.step, startSec: s.startSec, durationSec: s.durationSec, group: s.job,
    })));
    if (svg) charts['waterfall'] = svgImg(svg, 'Execution Timeline');
  }

  return charts;
}

/** Generate quickchart.io fallback URLs. */
export function generateWorkflowCharts(jobs: JobReport[]): Record<string, string> {
  const urls: Record<string, string> = {};
  const a = aggregateStats(jobs);
  const sorted = sortedJobs(jobs);

  // Stat cards
  urls['stat-cards'] = statCardChartUrl({
    runner: `${a.sys.cpu_count} × ${a.sys.cpu_model}`,
    runnerSub: `${(a.sys.total_memory_mb / 1024).toFixed(1)} GB · ${a.sys.runner_os}`,
    duration: fmtDuration(a.totalDuration),
    samples: a.totalSamples,
    cpuAvg: a.weightedCpuAvg,
    cpuPeak: a.cpuPeak,
    memAvgPct: a.memAvgPct,
    memPeakPct: a.memPeakPct,
    memPeakGb: `${(a.memPeak / 1024).toFixed(1)} GB`,
  });

  // CPU timeline
  const cpuValues = sorted.filter(j => j.report.timeline).flatMap(j => j.report.timeline!.cpu_pct);
  if (cpuValues.length >= 4) {
    urls['cpu-timeline'] = workflowTimelineUrl(cpuValues, {
      color: '#58a6ff', fillColor: 'rgba(88,166,255,0.15)',
      label: `CPU ${a.weightedCpuAvg.toFixed(0)}% avg`, yMax: 100,
    });
  }

  // Memory timeline
  const memValues = sorted.filter(j => j.report.timeline).flatMap(j => j.report.timeline!.mem_mb);
  if (memValues.length >= 4) {
    urls['mem-timeline'] = workflowTimelineUrl(memValues, {
      color: '#bc8cff', fillColor: 'rgba(188,140,255,0.15)',
      label: `Mem ${a.memAvgPct.toFixed(0)}% avg`, yMax: a.totalMb,
    });
  }

  // Execution waterfall
  const wfSteps = buildWaterfallSteps(sorted);
  if (wfSteps.length > 0) {
    urls['waterfall'] = waterfallChartUrl(wfSteps);
  }

  return urls;
}

// ─────────────────────────────────────────────────────────────
// Build workflow markdown with image URLs
// ─────────────────────────────────────────────────────────────

function workflowMarkdownWithImages(
  jobs: JobReport[],
  chartUrls: Record<string, string>,
): string {
  const L: string[] = [];
  const a = aggregateStats(jobs);

  L.push('## 📊 RunnerLens — Workflow Summary\n');

  // Stat cards — use SVG image if uploaded, otherwise HTML table
  if (chartUrls['stat-cards']) {
    L.push(`<img src="${chartUrls['stat-cards']}" alt="Workflow stats" width="600">\n`);
  } else {
    L.push(htmlStatCards([
      { label: 'Runner', value: `${a.sys.cpu_count} × ${a.sys.cpu_model}`, sub: `${(a.sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${a.sys.runner_os}` },
      { label: 'Duration', value: fmtDuration(a.totalDuration), sub: a.jobLabel },
      { label: 'Avg CPU', value: `${a.weightedCpuAvg.toFixed(0)}%`, sub: `peak ${a.cpuPeak.toFixed(0)}%` },
      { label: 'Memory', value: `${a.memAvgPct.toFixed(0)}% avg`, sub: `peak ${a.memPeakPct.toFixed(0)}% · ${(a.memPeak / 1024).toFixed(1)} GB` },
    ]) + '\n');
  }

  if (chartUrls['cpu-timeline']) {
    L.push(`<img src="${chartUrls['cpu-timeline']}" alt="CPU Timeline" width="600">\n`);
  }

  if (chartUrls['mem-timeline']) {
    L.push(`<img src="${chartUrls['mem-timeline']}" alt="Memory Timeline" width="600">\n`);
  }

  if (chartUrls['waterfall']) {
    L.push('### Execution Timeline\n');
    L.push(`<img src="${chartUrls['waterfall']}" alt="Execution Timeline" width="600">\n`);
  }

  L.push('---');
  L.push(
    `<sub><a href="https://runnerlens.com">RunnerLens</a> ` +
    `v${REPORT_VERSION} — Workflow Summary</sub>`,
  );

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Fallback: HTML tables + Unicode sparklines
// ─────────────────────────────────────────────────────────────

function workflowMarkdownFallback(jobs: JobReport[]): string {
  const L: string[] = [];
  const a = aggregateStats(jobs);

  L.push('## 📊 RunnerLens — Workflow Summary\n');

  L.push(htmlStatCards([
    { label: 'Runner', value: `${a.sys.cpu_count} × ${a.sys.cpu_model}`, sub: `${(a.sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${a.sys.runner_os}` },
    { label: 'Duration', value: fmtDuration(a.totalDuration), sub: a.jobLabel },
    { label: 'Avg CPU', value: `${a.weightedCpuAvg.toFixed(0)}%`, sub: `peak ${a.cpuPeak.toFixed(0)}%` },
    { label: 'Memory', value: `${a.memAvgPct.toFixed(0)}% avg`, sub: `peak ${a.memPeakPct.toFixed(0)}% · ${(a.memPeak / 1024).toFixed(1)} GB` },
  ]) + '\n');

  const sorted = [...jobs].sort((a, b) =>
    new Date(a.report.started_at).getTime() - new Date(b.report.started_at).getTime(),
  );

  // CPU & Memory Timeline Sparklines
  const cpuSegments = sorted.filter(j => j.report.timeline).flatMap(j => j.report.timeline!.cpu_pct);
  const memSegments = sorted.filter(j => j.report.timeline).flatMap(j => j.report.timeline!.mem_mb);

  if (cpuSegments.length >= 2 || memSegments.length >= 2) {
    const rows = [];
    if (cpuSegments.length >= 2) {
      rows.push({ label: 'CPU', values: cpuSegments, avg: `${a.weightedCpuAvg.toFixed(0)}% avg` });
    }
    if (memSegments.length >= 2) {
      const memPctValues = memSegments.map(v => a.totalMb > 0 ? (v / a.totalMb) * 100 : 0);
      rows.push({ label: 'Memory', values: memPctValues, avg: `${a.memAvgPct.toFixed(0)}% avg` });
    }
    L.push('### Timeline\n');
    L.push(htmlTimeline(rows) + '\n');
  }

  // Execution Timeline (Waterfall)
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

  L.push('---');
  L.push(
    `<sub><a href="https://runnerlens.com">RunnerLens</a> ` +
    `v${REPORT_VERSION} — Workflow Summary</sub>`,
  );

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Build workflow-level markdown.
 * When chartUrls are provided (SVGs uploaded), uses <img> tags.
 * Otherwise falls back to HTML tables with Unicode sparklines.
 */
export function workflowMarkdown(
  jobs: JobReport[],
  _config?: MonitorConfig,
  chartUrls?: Record<string, string>,
): string {
  if (chartUrls && Object.keys(chartUrls).length > 0) {
    return workflowMarkdownWithImages(jobs, chartUrls);
  }
  return workflowMarkdownFallback(jobs);
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

  // Generate SVG charts and try to upload (primary)
  const svgs = generateWorkflowSvgs(jobs);
  let chartUrls: Record<string, string> = {};
  if (config.githubToken && Object.keys(svgs).length > 0) {
    chartUrls = await uploadChartSvgs(svgs, config.githubToken);
  }
  // Fall back to quickchart.io URLs when SVG upload unavailable
  if (Object.keys(chartUrls).length === 0) {
    chartUrls = generateWorkflowCharts(jobs);
  }

  const md = workflowMarkdown(jobs, config, chartUrls);
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
