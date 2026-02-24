// ─────────────────────────────────────────────────────────────
// RunnerLens — Job Summary Builder
//
// Uses QuickChart.io for all visuals: stat cards, CPU/Memory
// line charts, and Gantt execution timeline.
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
    devicePixelRatio: 2,
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
  return `https://quickchart.io/chart?v=${CHART_VERSION}&c=${encoded}&w=760&h=250&bkg=${bkg}&f=png&devicePixelRatio=2`;
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
      devicePixelRatio: 2,
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

// ── Gantt Timeline (QuickChart.io horizontal bar chart) ──────

interface GanttJob {
  jobName: string;
  steps: { name: string; started_at: string; completed_at: string }[];
}

const GANTT_COLORS = [
  { bg: '#2f81f7', border: '#1a6dd8' },
  { bg: '#3fb950', border: '#2ea043' },
  { bg: '#f0883e', border: '#d68028' },
  { bg: '#bc8cff', border: '#9860e4' },
  { bg: '#f85149', border: '#da3633' },
  { bg: '#79c0ff', border: '#58a6ff' },
];

function collectGanttJobs(report: AggregatedReport, jobs?: JobReport[]): GanttJob[] {
  const ganttJobs: GanttJob[] = [];
  if (jobs && jobs.length > 0) {
    for (const job of jobs) {
      if (job.report.steps && job.report.steps.length > 0) {
        ganttJobs.push({ jobName: job.jobName, steps: job.report.steps });
      }
    }
  } else if (report.steps && report.steps.length > 0) {
    ganttJobs.push({ jobName: process.env.GITHUB_JOB || 'Job', steps: report.steps });
  }
  return ganttJobs;
}

function buildGanttChartString(ganttJobs: GanttJob[]): string {
  const rows: { label: string; startMs: number; endMs: number; durStr: string; color: string; isSep: boolean }[] = [];
  const groups: { startRow: number; endRow: number; ji: number }[] = [];

  for (let ji = 0; ji < ganttJobs.length; ji++) {
    const c = GANTT_COLORS[ji % GANTT_COLORS.length];
    // Separator row between job groups
    if (ji > 0) {
      rows.push({ label: '', startMs: 0, endMs: 0, durStr: '', color: 'transparent', isSep: true });
    }
    const startRow = rows.length;
    for (const step of ganttJobs[ji].steps) {
      const name = step.name.length > 24 ? step.name.slice(0, 22) + '..' : step.name;
      const sMs = new Date(step.started_at).getTime();
      const eMs = new Date(step.completed_at).getTime();
      rows.push({ label: name, startMs: sMs, endMs: eMs, durStr: fmtDuration(Math.round((eMs - sMs) / 1000)), color: c.bg, isSep: false });
    }
    groups.push({ startRow, endRow: rows.length - 1, ji });
  }

  const dataRows = rows.filter((r) => !r.isSep);
  const globalMin = Math.min(...dataRows.map((r) => r.startMs));
  const globalMax = Math.max(...dataRows.map((r) => r.endMs));
  const range = globalMax - globalMin || 1;
  const minBarWidth = range * 0.015;
  const durLabelPad = range * 0.12;

  const labels = JSON.stringify(rows.map((r) => r.label));
  const data = rows.map((r) => {
    if (r.isSep) return 'null';
    const w = r.endMs - r.startMs;
    const end = w < minBarWidth ? r.startMs + minBarWidth : r.endMs;
    return `[${r.startMs},${end}]`;
  }).join(',');
  const bgColors = JSON.stringify(rows.map((r) => r.color));

  const anns: string[] = [];

  // Gray track behind each data bar
  const trackHalf = 0.34;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].isSep) {
      anns.push(`tr${i}:{type:'box',drawTime:'beforeDatasetsDraw',xMin:${globalMin},xMax:${globalMax},yMin:${i - trackHalf},yMax:${i + trackHalf},backgroundColor:'#eff2f5',borderWidth:0,borderRadius:5}`);
    }
  }

  // Colored job name labels on the left + accent line per group
  for (const g of groups) {
    const c = GANTT_COLORS[g.ji % GANTT_COLORS.length];
    const midY = (g.startRow + g.endRow) / 2;
    const jobName = ganttJobs[g.ji].jobName;
    const truncName = jobName.length > 12 ? jobName.slice(0, 10) + '..' : jobName;
    // Job name label — positioned to the left of the chart area
    anns.push(`jn${g.ji}:{type:'label',drawTime:'afterDraw',xValue:${globalMin},xAdjust:-12,yValue:${midY},content:['${truncName}'],color:'${c.bg}',font:{size:12,weight:'bold'},textAlign:'right'}`);
    // Colored accent line on left edge of track area
    anns.push(`ac${g.ji}:{type:'box',drawTime:'beforeDatasetsDraw',xMin:${globalMin - range * 0.004},xMax:${globalMin + range * 0.004},yMin:${g.startRow - trackHalf},yMax:${g.endRow + trackHalf},backgroundColor:'${c.bg}',borderWidth:0,borderRadius:3}`);
  }

  // Duration labels on right
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].isSep) {
      anns.push(`du${i}:{type:'label',drawTime:'afterDatasetsDraw',xValue:${globalMax + durLabelPad * 0.5},yValue:${i},content:['${rows[i].durStr}'],color:'${TICK}',font:{size:11}}`);
    }
  }

  /* eslint-disable no-useless-escape */
  return `{
type:'bar',
data:{labels:${labels},datasets:[{data:[${data}],backgroundColor:${bgColors},borderWidth:0,borderRadius:5,borderSkipped:false,barPercentage:0.68,categoryPercentage:0.92}]},
options:{
  indexAxis:'y',
  plugins:{
    legend:{display:false},
    title:{display:true,text:'Execution Timeline',color:'${TITLE_COLOR}',font:{size:14,weight:'bold'},padding:{bottom:12}},
    annotation:{annotations:{${anns.join(',')}}}
  },
  scales:{
    x:{
      type:'linear',min:${globalMin - range * 0.01},max:${globalMax + durLabelPad},
      ticks:{color:'${TICK}',font:{size:10},maxRotation:0,
        callback:function(val){if(val>${globalMax})return '';var d=new Date(val);return d.getUTCHours().toString().padStart(2,'0')+':'+d.getUTCMinutes().toString().padStart(2,'0')+':'+d.getUTCSeconds().toString().padStart(2,'0')}
      },
      grid:{display:false},
      border:{display:false}
    },
    y:{ticks:{color:'${TITLE_COLOR}',font:{size:11},padding:80},grid:{display:false},border:{display:false}}
  },
  layout:{padding:{right:12,left:4,top:4,bottom:4}}
}}`;
  /* eslint-enable no-useless-escape */
}

async function buildGanttChart(ganttJobs: GanttJob[]): Promise<string> {
  const totalSteps = ganttJobs.reduce((n, j) => n + j.steps.length, 0);
  const separators = Math.max(0, ganttJobs.length - 1);
  const height = Math.max(160, Math.min(700, 64 + totalSteps * 36 + separators * 14));
  const chartStr = buildGanttChartString(ganttJobs);

  const body = JSON.stringify({
    version: CHART_VERSION,
    backgroundColor: CHART_BG,
    width: 760,
    height,
    devicePixelRatio: 2,
    format: 'png',
    chart: chartStr,
  });

  const url = await postQuickChart(body);
  return `<img src="${url}" alt="Execution Timeline" width="760">`;
}

/** Mermaid fallback if QuickChart fails */
function buildGanttFallback(ganttJobs: GanttJob[]): string {
  const lines: string[] = [
    '```mermaid',
    'gantt',
    '  title Execution Timeline',
    '  dateFormat x',
    '  axisFormat %H:%M:%S',
  ];
  for (const job of ganttJobs) {
    lines.push(`  section ${job.jobName.replace(/[:;]/g, '-')}`);
    for (const step of job.steps) {
      const s = new Date(step.started_at).getTime();
      const e = new Date(step.completed_at).getTime();
      lines.push(`  ${step.name.replace(/[:;]/g, '-')} : ${s}, ${e}`);
    }
  }
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

  // Gantt timeline — QuickChart.io horizontal bar chart with per-job colors
  const ganttJobs = collectGanttJobs(report, jobs);
  if (ganttJobs.length > 0) {
    try {
      parts.push(await buildGanttChart(ganttJobs));
    } catch {
      parts.push(buildGanttFallback(ganttJobs));
    }
  }

  parts.push(
    `<sub>Generated by <a href="https://github.com/runnerlens/runner-lens">RunnerLens</a> v${REPORT_VERSION}</sub>`,
  );

  return parts.join('\n\n');
}
