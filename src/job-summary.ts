// ─────────────────────────────────────────────────────────────
// RunnerLens — Job Summary Builder
//
// Uses QuickChart.io for all visuals: stat cards, CPU/Memory
// line charts, and Gantt execution timeline.
// ─────────────────────────────────────────────────────────────

import * as https from 'https';
import type { AggregatedReport, JobReport } from './types';
import { REPORT_VERSION } from './constants';
import { fmtDuration } from './stats';

// ── Palette ──────────────────────────────────────────────────

const CHART_BG = '#ffffff';
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

function shortOsName(release: string): string {
  // "Ubuntu 22.04.3 LTS" → "Ubuntu 22.04"
  const m = release.match(/^(\S+)\s+([\d]+\.[\d]+)/);
  if (m) return `${m[1]} ${m[2]}`;
  return release.length > 18 ? release.slice(0, 15) + '...' : release;
}

function shortCpuModel(model: string): string {
  // "AMD EPYC 7763 64-Core Processor" → "AMD EPYC 7763"
  return model
    .replace(/\s*\d+-Core Processor$/i, '')
    .replace(/\s*with\s+.*$/i, '')
    .replace(/\s+@\s+[\d.]+GHz$/i, '');
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
  const runnerValue = report.system.os_release !== 'unknown'
    ? shortOsName(report.system.os_release)
    : `${report.system.runner_os} (${report.system.runner_arch})`;
  const cpuModel = shortCpuModel(report.system.cpu_model);
  const runnerSub = `${cpuModel} \u00b7 ${report.system.cpu_count} vCPU \u00b7 ${fmtMem(report.system.total_memory_mb)}`;

  const cards = [
    { accent: '#3fb950', label: 'RUNNER', value: runnerValue, sub: runnerSub },
    { accent: '#58a6ff', label: 'DURATION', value: fmtDuration(report.duration_seconds), sub: `${report.sample_count} samples` },
    { accent: '#f0883e', label: 'CPU', value: `avg ${report.cpu.avg.toFixed(1)}%`, sub: `peak ${report.cpu.max.toFixed(1)}%` },
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
  const runnerValue = report.system.os_release !== 'unknown'
    ? shortOsName(report.system.os_release)
    : `${report.system.runner_os} (${report.system.runner_arch})`;
  const cpuModel = shortCpuModel(report.system.cpu_model);
  const specs = `${cpuModel} \u00b7 ${report.system.cpu_count} vCPU \u00b7 ${fmtMem(report.system.total_memory_mb)}`;
  const dur = fmtDuration(report.duration_seconds);

  return [
    `> **${runnerValue}** \u00b7 ${specs} \u00b7 **${dur}** \u00b7 ${report.sample_count} samples`,
    '',
    '| Metric | Average | Peak |',
    '|:--|--:|--:|',
    `| **CPU** | ${report.cpu.avg.toFixed(1)}% | ${report.cpu.max.toFixed(1)}% |`,
    `| **Memory** | ${fmtMem(report.memory.avg)} | ${fmtMem(report.memory.max)} / ${fmtMem(report.memory.total_mb)} |`,
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

interface JobSpan { jobName: string; startFrac: number; endFrac: number }

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
          grid: { display: false },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { color: TICK, font: { size: 11 } },
          grid: { color: '#eff2f5' },
          border: { display: false },
          title: { display: true, text: yAxisLabel, color: TICK, font: { size: 12 } },
        },
      },
      layout: { padding: { top: 4, right: 16, bottom: 4, left: 4 } },
    },
  };
}

/** Build line chart config as JS string with job boundary annotations */
function buildChartString(
  title: string,
  values: number[],
  labels: string[],
  lineColor: string,
  fillColor: string,
  yAxisLabel: string,
  jobSpans: JobSpan[],
): string {
  const n = labels.length - 1;
  const anns: string[] = [];

  for (let i = 0; i < jobSpans.length; i++) {
    const span = jobSpans[i];
    const name = span.jobName.length > 14 ? span.jobName.slice(0, 11) + '...' : span.jobName;
    const midIdx = ((span.startFrac + span.endFrac) / 2 * n).toFixed(2);

    // Dashed separator line between jobs (skip before the first job)
    if (i > 0) {
      const bIdx = (span.startFrac * n).toFixed(2);
      anns.push(`sl${i}:{type:'line',xMin:${bIdx},xMax:${bIdx},borderColor:'#c8ced6',borderWidth:1,borderDash:[5,3]}`);
    }

    // Centered job name label just above the x-axis
    anns.push(`jn${i}:{type:'label',xValue:${midIdx},yValue:0,yAdjust:-14,content:'${name}',color:'${TICK}',font:{size:10,weight:'bold'},backgroundColor:'rgba(255,255,255,0.85)',padding:{top:1,bottom:1,left:4,right:4},borderRadius:2}`);
  }

  return `{
type:'line',
data:{labels:${JSON.stringify(labels)},datasets:[{label:'${title}',data:${JSON.stringify(values)},borderColor:'${lineColor}',backgroundColor:'${fillColor}',fill:true,tension:0.4,pointRadius:0,borderWidth:2}]},
options:{
  plugins:{
    legend:{display:false},
    title:{display:true,text:'${title}',color:'${TITLE_COLOR}',font:{size:14,weight:'bold'},padding:{bottom:12}},
    annotation:{annotations:{${anns.join(',')}}}
  },
  scales:{
    x:{ticks:{color:'${TICK}',font:{size:11},maxRotation:0,autoSkipPadding:20},grid:{display:false},border:{display:false}},
    y:{beginAtZero:true,ticks:{color:'${TICK}',font:{size:11}},grid:{color:'#eff2f5'},border:{display:false},title:{display:true,text:'${yAxisLabel}',color:'${TICK}',font:{size:12}}}
  },
  layout:{padding:{top:4,right:16,bottom:20,left:4}}
}}`;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Multi-Job Chart (one colored line per job) ──────────────

interface JobTimeline {
  jobName: string;
  values: number[];
  startedAt: string;
  endedAt: string;
}

function buildMultiJobChartString(
  title: string,
  jobTimelines: JobTimeline[],
  labels: string[],
  yAxisLabel: string,
  globalStartMs: number,
  globalEndMs: number,
): string {
  const n = labels.length;
  const globalDur = globalEndMs - globalStartMs || 1;

  const datasets: string[] = [];

  for (let i = 0; i < jobTimelines.length; i++) {
    const jt = jobTimelines[i];
    const color = GANTT_COLORS[i % GANTT_COLORS.length];

    const jobStartMs = new Date(jt.startedAt).getTime();
    const jobEndMs = new Date(jt.endedAt).getTime();
    const startFrac = Math.max(0, (jobStartMs - globalStartMs) / globalDur);
    const endFrac = Math.min(1, (jobEndMs - globalStartMs) / globalDur);
    const startIdx = Math.round(startFrac * (n - 1));
    const endIdx = Math.round(endFrac * (n - 1));

    const span = Math.max(1, endIdx - startIdx + 1);
    const downsampled = downsample(jt.values, span);

    const data: (number | null)[] = new Array(n).fill(null);
    for (let j = 0; j < downsampled.length; j++) {
      data[startIdx + j] = downsampled[j];
    }

    const hex = color.bg;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const fillColor = `rgba(${r},${g},${b},0.08)`;

    const name = jt.jobName.replace(/'/g, "\\'");

    datasets.push(`{label:'${name}',data:${JSON.stringify(data)},borderColor:'${hex}',backgroundColor:'${fillColor}',fill:true,tension:0.4,pointRadius:0,borderWidth:2,spanGaps:false}`);
  }

  return `{
type:'line',
data:{labels:${JSON.stringify(labels)},datasets:[${datasets.join(',')}]},
options:{
  plugins:{
    legend:{display:true,labels:{color:'${TITLE_COLOR}',font:{size:11},boxWidth:12,padding:8}},
    title:{display:true,text:'${title}',color:'${TITLE_COLOR}',font:{size:14,weight:'bold'},padding:{bottom:12}}
  },
  scales:{
    x:{ticks:{color:'${TICK}',font:{size:11},maxRotation:0,autoSkipPadding:20},grid:{display:false},border:{display:false}},
    y:{beginAtZero:true,ticks:{color:'${TICK}',font:{size:11}},grid:{color:'#eff2f5'},border:{display:false},title:{display:true,text:'${yAxisLabel}',color:'${TICK}',font:{size:12}}}
  },
  layout:{padding:{top:4,right:16,bottom:4,left:4}}
}}`;
}

async function buildMultiJobQuickChart(
  title: string,
  jobTimelines: JobTimeline[],
  yLabel: string,
  globalStartedAt: string,
  globalEndedAt: string,
): Promise<string> {
  const globalStartMs = new Date(globalStartedAt).getTime();
  const globalEndMs = new Date(globalEndedAt).getTime();
  const maxPts = 30;
  const labels = timeLabels(globalStartedAt, globalEndedAt, maxPts);

  const chartStr = buildMultiJobChartString(title, jobTimelines, labels, yLabel, globalStartMs, globalEndMs);
  const body = JSON.stringify({
    version: CHART_VERSION,
    backgroundColor: CHART_BG,
    width: 760,
    height: 250,
    devicePixelRatio: 2,
    format: 'png',
    chart: chartStr,
  });
  const url = await postQuickChart(body);
  return `<img src="${url}" alt="${esc(title)}" width="760">`;
}

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
  jobSpans?: JobSpan[],
): Promise<string> {
  const maxPts = 30;
  const data = downsample(values, maxPts);
  const labels = timeLabels(startedAt, endedAt, data.length);

  let url: string;
  if (jobSpans && jobSpans.length > 0) {
    // Use JS string config + POST for job boundary annotations
    // (same rendering path as Gantt chart — proven to work)
    const chartStr = buildChartString(title, data, labels, lineColor, fillColor, yLabel, jobSpans);
    const body = JSON.stringify({
      version: CHART_VERSION,
      backgroundColor: CHART_BG,
      width: 760,
      height: 250,
      devicePixelRatio: 2,
      format: 'png',
      chart: chartStr,
    });
    url = await postQuickChart(body);
  } else {
    const config = buildChartConfig(title, data, labels, lineColor, fillColor, yLabel);
    url = buildChartUrl(config);
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
  const multiJob = ganttJobs.length > 1;

  interface Row { label: string; startMs: number; endMs: number; durStr: string; color: string; jobIdx: number; isHeader: boolean }
  const rows: Row[] = [];

  // First pass: collect step rows to compute globalMin/globalMax
  const stepRows: { label: string; startMs: number; endMs: number; durStr: string; color: string; jobIdx: number }[] = [];
  for (let ji = 0; ji < ganttJobs.length; ji++) {
    const c = GANTT_COLORS[ji % GANTT_COLORS.length];
    for (const step of ganttJobs[ji].steps) {
      const name = step.name.length > 28 ? step.name.slice(0, 25) + '...' : step.name;
      const sMs = new Date(step.started_at).getTime();
      const eMs = new Date(step.completed_at).getTime();
      stepRows.push({ label: name, startMs: sMs, endMs: eMs, durStr: fmtDuration(Math.round((eMs - sMs) / 1000)), color: c.bg, jobIdx: ji });
    }
  }

  const globalMin = Math.min(...stepRows.map((r) => r.startMs));
  const globalMax = Math.max(...stepRows.map((r) => r.endMs));

  // Second pass: build rows with header rows for multi-job
  for (let ji = 0; ji < ganttJobs.length; ji++) {
    const c = GANTT_COLORS[ji % GANTT_COLORS.length];

    if (multiJob) {
      const jn = ganttJobs[ji].jobName.length > 20 ? ganttJobs[ji].jobName.slice(0, 17) + '...' : ganttJobs[ji].jobName;
      rows.push({ label: jn.toUpperCase(), startMs: globalMin, endMs: globalMin, durStr: '', color: 'transparent', jobIdx: ji, isHeader: true });
    }

    for (const step of ganttJobs[ji].steps) {
      const name = step.name.length > 28 ? step.name.slice(0, 25) + '...' : step.name;
      const sMs = new Date(step.started_at).getTime();
      const eMs = new Date(step.completed_at).getTime();
      rows.push({ label: name, startMs: sMs, endMs: eMs, durStr: fmtDuration(Math.round((eMs - sMs) / 1000)), color: c.bg, jobIdx: ji, isHeader: false });
    }
  }

  const range = globalMax - globalMin || 1;
  const minBarWidth = range * 0.015;
  const durLabelPad = range * 0.10;

  const labels = JSON.stringify(rows.map((r) => r.label));
  const data = rows.map((r) => {
    if (r.isHeader) return `[${globalMin},${globalMin}]`;
    const w = r.endMs - r.startMs;
    const end = w < minBarWidth ? r.startMs + minBarWidth : r.endMs;
    return `[${r.startMs},${end}]`;
  }).join(',');
  const bgColors = JSON.stringify(rows.map((r) => r.isHeader ? 'transparent' : r.color));

  const anns: string[] = [];

  // Track backgrounds — flush, no gaps
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.isHeader) {
      // Header row: colored background matching job color (light)
      const hex = GANTT_COLORS[row.jobIdx % GANTT_COLORS.length].bg;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      anns.push(`tr${i}:{type:'box',drawTime:'beforeDatasetsDraw',xMin:${globalMin},xMax:${globalMax},yMin:${i - 0.5},yMax:${i + 0.5},backgroundColor:'rgba(${r},${g},${b},0.10)',borderWidth:0}`);
    } else {
      anns.push(`tr${i}:{type:'box',drawTime:'beforeDatasetsDraw',xMin:${globalMin},xMax:${globalMax},yMin:${i - 0.5},yMax:${i + 0.5},backgroundColor:'${i % 2 === 0 ? '#f6f8fa' : '#eff2f5'}',borderWidth:0}`);
    }
  }

  // Duration labels on right (skip header rows)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].isHeader) continue;
    anns.push(`du${i}:{type:'label',drawTime:'afterDatasetsDraw',xValue:${globalMax + durLabelPad * 0.5},yValue:${i},content:['${rows[i].durStr}'],color:'${TICK}',font:{size:10}}`);
  }

  // Y-axis tick colors: header rows get job color, step rows get default
  const tickColors: string[] = rows.map((r) => {
    if (r.isHeader) return GANTT_COLORS[r.jobIdx % GANTT_COLORS.length].bg;
    return TICK;
  });

  /* eslint-disable no-useless-escape */
  return `{
type:'bar',
data:{labels:${labels},datasets:[{data:[${data}],backgroundColor:${bgColors},borderWidth:0,borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:1.0}]},
options:{
  indexAxis:'y',
  plugins:{
    legend:{display:false},
    title:{display:true,text:'Execution Timeline',color:'${TITLE_COLOR}',font:{size:14,weight:'bold'},padding:{bottom:8}},
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
    y:{
      ticks:{
        color:${JSON.stringify(tickColors)},
        font:{size:11,weight:function(ctx){return ${JSON.stringify(rows.map(r => r.isHeader))}[ctx.index]?'bold':'normal'}},
        padding:6
      },
      grid:{display:false},
      border:{display:false}
    }
  },
  layout:{padding:{right:8,left:4,top:4,bottom:4}}
}}`;
  /* eslint-enable no-useless-escape */
}

async function buildGanttChart(ganttJobs: GanttJob[]): Promise<string> {
  const totalSteps = ganttJobs.reduce((n, j) => n + j.steps.length, 0);
  const height = Math.max(160, Math.min(700, 56 + totalSteps * 26));
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
  const isMultiJob = jobs && jobs.length > 1;

  if (isMultiJob) {
    parts.push('<h2>Workflow Summary</h2>');
  }

  // Stat cards (image with fallback to markdown)
  try {
    parts.push(await buildStatCardsImage(report));
  } catch {
    parts.push(buildStatCardsFallback(report));
  }

  // CPU + Memory charts via QuickChart.io
  const timeline = report.timeline;
  if (timeline && timeline.cpu_pct.length >= 2) {
    const hasMultiJobTimelines = jobs && jobs.length > 1 && jobs.some(j => j.report.timeline);

    try {
      if (hasMultiJobTimelines) {
        // Multi-job path: each job = separate colored line
        // Trim timelines to step-based bounds to avoid empty space from idle collector
        const cpuJobTimelines: JobTimeline[] = [];
        const memJobTimelines: JobTimeline[] = [];
        for (const job of jobs!) {
          if (job.report.timeline) {
            const jobSteps = job.report.steps ?? [];
            const jobStartMs = new Date(job.report.started_at).getTime();
            const jobEndMs = new Date(job.report.ended_at).getTime();
            const totalDur = jobEndMs - jobStartMs || 1;

            // Use last step's end time as effective end (avoid idle tail)
            let effectiveEndMs = jobEndMs;
            if (jobSteps.length > 0) {
              effectiveEndMs = Math.max(...jobSteps.map(s => new Date(s.completed_at).getTime()));
              effectiveEndMs = Math.min(effectiveEndMs, jobEndMs);
            }

            const keepRatio = (effectiveEndMs - jobStartMs) / totalDur;
            const keepCount = Math.max(1, Math.ceil(keepRatio * job.report.timeline.cpu_pct.length));

            cpuJobTimelines.push({
              jobName: job.jobName,
              values: job.report.timeline.cpu_pct.slice(0, keepCount),
              startedAt: job.report.started_at,
              endedAt: new Date(effectiveEndMs).toISOString(),
            });
            memJobTimelines.push({
              jobName: job.jobName,
              values: job.report.timeline.mem_mb.slice(0, keepCount),
              startedAt: job.report.started_at,
              endedAt: new Date(effectiveEndMs).toISOString(),
            });
          }
        }

        // Use step-based end time for chart labels to avoid empty space
        const allJobSteps = jobs!.flatMap(j => j.report.steps ?? []);
        let chartStartedAt = report.started_at;
        let chartEndedAt = report.ended_at;
        if (allJobSteps.length > 0) {
          chartEndedAt = new Date(
            Math.max(...allJobSteps.map(s => new Date(s.completed_at).getTime())),
          ).toISOString();
        }

        const cpuChart = await buildMultiJobQuickChart(
          'CPU Usage (%)', cpuJobTimelines, 'CPU %',
          chartStartedAt, chartEndedAt,
        );
        parts.push(cpuChart);

        const memChart = await buildMultiJobQuickChart(
          'Memory Usage (MB)', memJobTimelines, 'MB',
          chartStartedAt, chartEndedAt,
        );
        parts.push(memChart);
      } else {
        // Single-line path: one color with optional job boundary annotations
        // Trim timeline to step-based bounds to avoid empty space from idle collector
        let chartStartedAt = report.started_at;
        let chartEndedAt = report.ended_at;
        let chartCpuPct = timeline.cpu_pct;
        let chartMemMb = timeline.mem_mb;

        const singleJobSteps = report.steps ?? [];
        if (singleJobSteps.length > 0) {
          const reportStartMs = new Date(report.started_at).getTime();
          const reportEndMs = new Date(report.ended_at).getTime();
          const totalDur = reportEndMs - reportStartMs || 1;
          const lastStepMs = Math.max(...singleJobSteps.map(s => new Date(s.completed_at).getTime()));
          const effectiveEnd = Math.min(lastStepMs, reportEndMs);
          const keepRatio = (effectiveEnd - reportStartMs) / totalDur;
          const keepCount = Math.max(1, Math.ceil(keepRatio * timeline.cpu_pct.length));
          chartCpuPct = timeline.cpu_pct.slice(0, keepCount);
          chartMemMb = timeline.mem_mb.slice(0, keepCount);
          chartEndedAt = new Date(effectiveEnd).toISOString();
        }

        const tStart = new Date(chartStartedAt).getTime();
        const tEnd = new Date(chartEndedAt).getTime();
        const tDur = tEnd - tStart || 1;
        const ganttJobsForSeps = collectGanttJobs(report, jobs);
        const jobSpans: JobSpan[] = [];
        if (ganttJobsForSeps.length > 1) {
          for (const job of ganttJobsForSeps) {
            if (job.steps.length === 0) continue;
            const firstStep = job.steps[0];
            const lastStep = job.steps[job.steps.length - 1];
            const startFrac = Math.max(0, (new Date(firstStep.started_at).getTime() - tStart) / tDur);
            const endFrac = Math.min(1, (new Date(lastStep.completed_at).getTime() - tStart) / tDur);
            jobSpans.push({ jobName: job.jobName, startFrac, endFrac });
          }
        }

        const cpuChart = await buildQuickChart(
          'CPU Usage (%)',
          chartCpuPct,
          'CPU %',
          CPU_COLOR,
          CPU_FILL,
          chartStartedAt,
          chartEndedAt,
          jobSpans.length > 1 ? jobSpans : undefined,
        );
        parts.push(cpuChart);

        const memChart = await buildQuickChart(
          'Memory Usage (MB)',
          chartMemMb,
          'MB',
          MEM_COLOR,
          MEM_FILL,
          chartStartedAt,
          chartEndedAt,
          jobSpans.length > 1 ? jobSpans : undefined,
        );
        parts.push(memChart);
      }
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
