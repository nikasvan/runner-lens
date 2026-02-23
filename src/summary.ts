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
  svgImg, svgToDataImg, statCards, workflowTimelineChart, waterfallChart,
  type TimelineSegment,
} from './svg-charts';
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
// Build workflow markdown with SVG data URI images
// ─────────────────────────────────────────────────────────────

function workflowMarkdownHtml(_jobs: JobReport[], svgs: Record<string, string>): string {
  const L: string[] = [];

  L.push('## 📊 RunnerLens — Workflow Summary\n');

  if (svgs['stat-cards']) {
    L.push(svgToDataImg(svgs['stat-cards'], 'Workflow stats') + '\n');
  }

  if (svgs['cpu-timeline']) {
    L.push('### CPU Usage\n');
    L.push(svgToDataImg(svgs['cpu-timeline'], 'CPU Timeline') + '\n');
  }

  if (svgs['mem-timeline']) {
    L.push('### Memory Usage\n');
    L.push(svgToDataImg(svgs['mem-timeline'], 'Memory Timeline') + '\n');
  }

  if (svgs['waterfall']) {
    L.push('### Execution Timeline\n');
    L.push(svgToDataImg(svgs['waterfall'], 'Execution Timeline') + '\n');
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
 * Build workflow-level markdown using SVG data URI images.
 * SVGs are base64-encoded and embedded as <img> tags for
 * reliable rendering in GitHub Job Summary.
 */
export function workflowMarkdown(
  jobs: JobReport[],
  _config?: MonitorConfig,
  svgs?: Record<string, string>,
): string {
  const resolvedSvgs = svgs ?? generateWorkflowSvgs(jobs);
  return workflowMarkdownHtml(jobs, resolvedSvgs);
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

  // Generate SVG charts for both upload and embedding
  const svgs = generateWorkflowSvgs(jobs);
  if (config.githubToken && Object.keys(svgs).length > 0) {
    await uploadChartSvgs(svgs, config.githubToken);
  }
  const md = workflowMarkdown(jobs, config, svgs);
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
