// ─────────────────────────────────────────────────────────────
// RunnerLens — Job Summary Builder
//
// Uses QuickChart.io for all visuals (stat cards + charts),
// Mermaid for Gantt timeline.
// ─────────────────────────────────────────────────────────────

import * as https from 'https';
import type { AggregatedReport, JobReport } from './types';
import { REPORT_VERSION } from './constants';
import { fmtDuration } from './svg-charts';

// ── Palette ──────────────────────────────────────────────────

const CHART_BG = '#ffffff';
const GRID = '#d0d7de';
const TICK = '#656d76';
const TITLE_COLOR = '#1f2328';
const CPU_COLOR = '#2f81f7';
const CPU_FILL = 'rgba(47,129,247,0.10)';
const MEM_COLOR = '#8250df';
const MEM_FILL = 'rgba(130,80,223,0.10)';
const CHART_VERSION = '4';

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── QuickChart HTTP helper ───────────────────────────────────

function postQuickChart(body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://quickchart.io/chart/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { success: boolean; url: string };
            if (parsed.success && parsed.url) {
              resolve(parsed.url);
            } else {
              reject(new Error(`QuickChart API error: ${data}`));
            }
          } catch {
            reject(new Error(`QuickChart response parse error: ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('QuickChart timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Stat Cards (rendered as image via chartjs-plugin-annotation) ──

function buildStatCardsConfig(report: AggregatedReport): Record<string, any> {
  const cards = [
    { accent: '#3fb950', label: 'RUNNER', value: `${report.system.runner_os} (${report.system.runner_arch})`, sub: `${report.system.cpu_count} vCPU \u00b7 ${fmtMem(report.system.total_memory_mb)}` },
    { accent: '#58a6ff', label: 'DURATION', value: fmtDuration(report.duration_seconds), sub: `${report.sample_count} samples` },
    { accent: '#f0883e', label: 'CPU', value: `avg ${report.cpu.avg.toFixed(1)}%`, sub: `p95 ${report.cpu.p95.toFixed(1)}% \u00b7 peak ${report.cpu.max.toFixed(1)}%` },
    { accent: '#bc8cff', label: 'MEMORY', value: `avg ${fmtMem(report.memory.avg)}`, sub: `peak ${fmtMem(report.memory.max)} / ${fmtMem(report.memory.total_mb)}` },
  ];

  const annotations: Record<string, any> = {};

  cards.forEach((c, i) => {
    const xMin = i + 0.03;
    const xMax = i + 0.97;
    const xMid = i + 0.5;

    // Card background
    annotations[`bg${i}`] = {
      type: 'box', xMin, xMax, yMin: 0, yMax: 1,
      backgroundColor: '#f6f8fa', borderColor: '#d0d7de', borderWidth: 1, borderRadius: 6,
    };
    // Colored accent bar at top
    annotations[`ac${i}`] = {
      type: 'box', xMin, xMax, yMin: 0.94, yMax: 1.0,
      backgroundColor: c.accent, borderWidth: 0, borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
    };
    // Label
    annotations[`lb${i}`] = {
      type: 'label', xValue: xMid, yValue: 0.74,
      content: [c.label], color: '#656d76', font: { size: 11 },
    };
    // Value
    annotations[`vl${i}`] = {
      type: 'label', xValue: xMid, yValue: 0.47,
      content: [c.value], color: '#1f2328', font: { size: 17, weight: 'bold' },
    };
    // Sub-text
    annotations[`sb${i}`] = {
      type: 'label', xValue: xMid, yValue: 0.18,
      content: [c.sub], color: '#8b949e', font: { size: 10 },
    };
  });

  return {
    type: 'scatter',
    data: { datasets: [{ data: [] }] },
    options: {
      layout: { padding: 0 },
      scales: {
        x: { display: false, min: -0.05, max: 4.05 },
        y: { display: false, min: -0.12, max: 1.12 },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        annotation: { annotations },
      },
    },
  };
}

async function buildStatCardsImage(report: AggregatedReport): Promise<string> {
  const config = buildStatCardsConfig(report);
  const body = JSON.stringify({
    version: CHART_VERSION,
    backgroundColor: CHART_BG,
    width: 760,
    height: 100,
    format: 'png',
    chart: config,
  });
  const url = await postQuickChart(body);
  return `<img src="${url}" alt="Runner Stats" width="760">`;
}

/** Markdown fallback if image rendering fails */
function buildStatCardsFallback(report: AggregatedReport): string {
  const runner = `${report.system.runner_os} (${report.system.runner_arch})`;
  const specs = `${report.system.cpu_count} vCPU \u00b7 ${fmtMem(report.system.total_memory_mb)}`;
  const dur = fmtDuration(report.duration_seconds);

  return [
    `> **${runner}** \u00b7 ${specs} \u00b7 **${dur}** \u00b7 ${report.sample_count} samples`,
    '',
    '| Metric | Average | P95 | Peak |',
    '|:--|--:|--:|--:|',
    `| **CPU** | ${report.cpu.avg.toFixed(1)}% | ${report.cpu.p95.toFixed(1)}% | ${report.cpu.max.toFixed(1)}% |`,
    `| **Memory** | ${fmtMem(report.memory.avg)} | ${fmtMem(report.memory.p95)} | ${fmtMem(report.memory.max)} / ${fmtMem(report.memory.total_mb)} |`,
  ].join('\n');
}

// ── QuickChart.io CPU/Memory Charts ─────────────────────────

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const step = values.length / maxPoints;
  const result: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const lo = Math.floor(i * step);
    const hi = Math.min(Math.floor((i + 1) * step), values.length);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += values[j];
    result.push(Math.round((sum / (hi - lo)) * 10) / 10);
  }
  return result;
}

function timeLabels(startedAt: string, endedAt: string, count: number): string[] {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const labels: string[] = [];
  const labelInterval = Math.max(1, Math.ceil(count / 8));
  for (let i = 0; i < count; i++) {
    const t = new Date(start + ((end - start) * i) / Math.max(count - 1, 1));
    const hh = t.getUTCHours().toString().padStart(2, '0');
    const mm = t.getUTCMinutes().toString().padStart(2, '0');
    const ss = t.getUTCSeconds().toString().padStart(2, '0');
    if (i % labelInterval === 0 || i === count - 1) {
      labels.push(`${hh}:${mm}:${ss}`);
    } else {
      labels.push('');
    }
  }
  return labels;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildChartConfig(
  title: string,
  values: number[],
  labels: string[],
  lineColor: string,
  fillColor: string,
  yAxisLabel: string,
): Record<string, any> {
  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: title,
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: title,
          color: TITLE_COLOR,
          font: { size: 14, weight: 'bold' },
          padding: { bottom: 12 },
        },
      },
      scales: {
        x: {
          ticks: { color: TICK, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 20 },
          grid: { color: GRID },
        },
        y: {
          beginAtZero: true,
          ticks: { color: TICK, font: { size: 11 } },
          grid: { color: GRID },
          title: { display: true, text: yAxisLabel, color: TICK, font: { size: 12 } },
        },
      },
      layout: { padding: { top: 4, right: 16, bottom: 4, left: 4 } },
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const QUICKCHART_URL_LIMIT = 1800;

function buildChartUrl(config: Record<string, any>): string {
  const json = JSON.stringify(config);
  const encoded = encodeURIComponent(json);
  const bkg = encodeURIComponent(CHART_BG);
  return `https://quickchart.io/chart?v=${CHART_VERSION}&c=${encoded}&w=760&h=250&bkg=${bkg}&f=png`;
}

async function buildQuickChart(
  title: string,
  values: number[],
  yLabel: string,
  lineColor: string,
  fillColor: string,
  startedAt: string,
  endedAt: string,
): Promise<string> {
  const maxPts = 30;
  const data = downsample(values, maxPts);
  const labels = timeLabels(startedAt, endedAt, data.length);
  const config = buildChartConfig(title, data, labels, lineColor, fillColor, yLabel);

  let url = buildChartUrl(config);
  if (url.length > QUICKCHART_URL_LIMIT) {
    const body = JSON.stringify({
      version: CHART_VERSION,
      backgroundColor: CHART_BG,
      width: 760,
      height: 250,
      format: 'png',
      chart: config,
    });
    try {
      url = await postQuickChart(body);
    } catch {
      // If short-URL fails, use long URL anyway
    }
  }

  return `<img src="${url}" alt="${esc(title)}" width="760">`;
}

// ── Mermaid Gantt Timeline ───────────────────────────────────

interface GanttJob {
  jobName: string;
  steps: { name: string; started_at: string; completed_at: string }[];
}

// Mermaid task tags — each maps to a different theme color set.
// default=blue, active=green, crit=orange, done=purple
const GANTT_TASK_TAGS = ['', 'active, ', 'crit, ', 'done, '];

function buildGanttThemeInit(): string {
  const vars = [
    "'primaryColor': '#2f81f7'",
    "'primaryTextColor': '#fff'",
    "'primaryBorderColor': '#1a6dd8'",
    // default bars (blue)
    "'taskBkgColor': '#2f81f7'",
    "'taskBorderColor': '#1a6dd8'",
    "'taskTextColor': '#fff'",
    "'taskTextLightColor': '#fff'",
    // active bars (green)
    "'activeTaskBkgColor': '#3fb950'",
    "'activeTaskBorderColor': '#2ea043'",
    // crit bars (orange)
    "'critBkgColor': '#f0883e'",
    "'critBorderColor': '#d68028'",
    // done bars (purple)
    "'doneTaskBkgColor': '#bc8cff'",
    "'doneTaskBorderColor': '#9860e4'",
    // section backgrounds — alternating subtle tints
    "'sectionBkgColor': '#f0f6ff'",
    "'sectionBkgColor2': '#f0fff4'",
    "'altSectionBkgColor': '#f0f6ff'",
    // grid
    "'gridColor': '#d0d7de'",
    "'todayLineColor': 'transparent'",
  ];
  return `%%{init: {'theme': 'base', 'themeVariables': {${vars.join(', ')}}}}%%`;
}

function buildMermaidGantt(report: AggregatedReport, jobs?: JobReport[]): string {
  const lines: string[] = [
    '```mermaid',
    buildGanttThemeInit(),
    'gantt',
    '  title Execution Timeline',
    '  dateFormat x',
    '  axisFormat %H:%M:%S',
  ];

  // Build list of jobs with their steps
  const ganttJobs: GanttJob[] = [];

  if (jobs && jobs.length > 0) {
    // Multi-job: each JobReport becomes a section with distinct bar color
    for (const job of jobs) {
      if (job.report.steps && job.report.steps.length > 0) {
        ganttJobs.push({ jobName: job.jobName, steps: job.report.steps });
      }
    }
  } else if (report.steps && report.steps.length > 0) {
    // Single-job: use the runner name or a default
    const jobName = process.env.GITHUB_JOB || 'Job';
    ganttJobs.push({ jobName, steps: report.steps });
  }

  ganttJobs.forEach((job, jobIndex) => {
    const sectionName = job.jobName.replace(/[:;]/g, '-');
    const tag = GANTT_TASK_TAGS[jobIndex % GANTT_TASK_TAGS.length];
    lines.push(`  section ${sectionName}`);
    for (const step of job.steps) {
      const startMs = new Date(step.started_at).getTime();
      const endMs = new Date(step.completed_at).getTime();
      const name = step.name.replace(/[:;]/g, '-');
      lines.push(`  ${name} :${tag}${startMs}, ${endMs}`);
    }
  });

  lines.push('```');
  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────

export async function buildJobSummary(report: AggregatedReport, jobs?: JobReport[]): Promise<string> {
  const parts: string[] = [];

  // Stat cards (image with fallback to markdown)
  try {
    parts.push(await buildStatCardsImage(report));
  } catch {
    parts.push(buildStatCardsFallback(report));
  }

  // CPU + Memory charts via QuickChart.io
  const timeline = report.timeline;
  if (timeline && timeline.cpu_pct.length >= 2) {
    try {
      const cpuChart = await buildQuickChart(
        'CPU Usage (%)',
        timeline.cpu_pct,
        'CPU %',
        CPU_COLOR,
        CPU_FILL,
        report.started_at,
        report.ended_at,
      );
      parts.push(cpuChart);

      const memChart = await buildQuickChart(
        'Memory Usage (MB)',
        timeline.mem_mb,
        'MB',
        MEM_COLOR,
        MEM_FILL,
        report.started_at,
        report.ended_at,
      );
      parts.push(memChart);
    } catch {
      // Best-effort: if QuickChart fails, skip charts
    }
  }

  // Gantt timeline — grouped by jobs with sections for color differentiation
  const hasMultiJobSteps = jobs && jobs.some((j) => j.report.steps && j.report.steps.length > 0);
  const hasSingleJobSteps = report.steps && report.steps.length > 0;
  if (hasMultiJobSteps || hasSingleJobSteps) {
    parts.push(buildMermaidGantt(report, jobs));
  }

  parts.push(
    `<sub>Generated by <a href="https://github.com/runnerlens/runner-lens">RunnerLens</a> v${REPORT_VERSION}</sub>`,
  );

  return parts.join('\n\n');
}
