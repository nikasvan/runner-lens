// ─────────────────────────────────────────────────────────────
// RunnerLens — Job Summary Builder
//
// Generates QuickChart.io GET URLs for all visuals. GET URLs
// embed the full chart config in the URL itself — they never
// expire and require no API calls during generation.
// ─────────────────────────────────────────────────────────────

import type { AggregatedReport } from './types';
import { REPORT_VERSION } from './constants';
import { fmtDuration, safeMax, safeMin } from './stats';

// ── Palette ──────────────────────────────────────────────────

const CHART_BG = '#ffffff';
const TICK = '#656d76';
const TITLE_COLOR = '#1f2328';
const CPU_COLOR = '#2f81f7';
const CPU_FILL = 'rgba(47,129,247,0.10)';
const CPU_USER_COLOR = '#3fb950';
const CPU_SYS_COLOR = '#f0883e';
const MEM_COLOR = '#8250df';
const MEM_FILL = 'rgba(130,80,223,0.10)';
const MEM_CACHED_COLOR = '#58a6ff';
const MEM_SWAP_COLOR = '#da3633';
const CHART_VERSION = '4';

function fmtMem(mb: number): string {
  return `${(mb / 1024).toFixed(2)} GB`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortOsName(release: string): string {
  // "Ubuntu 22.04.3 LTS" → "Ubuntu 22.04"
  const m = release.match(/^(\S+)\s+([\d]+\.[\d]+)/);
  if (m) return `${m[1]} ${m[2]}`;
  return release.length > 18 ? release.slice(0, 15) + '...' : release;
}

function shortCpuModel(model: string): string {
  // "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz" → "Xeon Platinum 8370C"
  // "AMD EPYC 7763 64-Core Processor" → "EPYC 7763"
  let s = model
    .replace(/\(R\)/gi, '')
    .replace(/\(TM\)/gi, '')
    .replace(/\s*\d+-Core Processor$/i, '')
    .replace(/\s*with\s+.*$/i, '')
    .replace(/\s+@\s+[\d.]+GHz$/i, '')
    .replace(/\s+CPU$/i, '')
    .replace(/^Intel\s+/i, '')
    .replace(/^AMD\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > 24) s = s.slice(0, 21) + '...';
  return s;
}

/** Escape a string for safe embedding in a JS single-quoted string literal. */
function escJs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ── QuickChart GET URL builder ────────────────────────────────

// Safe limit for GET URLs. QuickChart supports ~16K, but proxies
// GitHub's Camo proxy hex-encodes URLs, roughly doubling their length.
// A 4K source URL becomes ~8K after encoding, staying under proxy limits.
const MAX_URL_LEN = 4000;

function chartGetUrl(config: string | Record<string, unknown>, width: number, height: number): string {
  const configStr = typeof config === 'string' ? config : JSON.stringify(config);
  const encoded = encodeURIComponent(configStr);
  const bkg = encodeURIComponent(CHART_BG);
  return `https://quickchart.io/chart?v=${CHART_VERSION}&c=${encoded}&w=${width}&h=${height}&bkg=${bkg}&f=png&devicePixelRatio=2`;
}

/** Keep only the N longest-duration items, preserving chronological order. */
function keepLongest<T extends { started_at: string; completed_at: string }>(
  items: T[], n: number,
): T[] {
  if (items.length <= n) return items;
  return items
    .map((item, idx) => ({ item, idx, dur: new Date(item.completed_at).getTime() - new Date(item.started_at).getTime() }))
    .sort((a, b) => b.dur - a.dur)
    .slice(0, n)
    .sort((a, b) => a.idx - b.idx)
    .map(e => e.item);
}

// ── Stat Cards (rendered as image via chartjs-plugin-annotation) ──

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildStatCardsConfig(report: AggregatedReport): Record<string, any> {
  const runnerValue = report.system.os_release !== 'unknown'
    ? shortOsName(report.system.os_release)
    : `${report.system.runner_os} (${report.system.runner_arch})`;
  const cpuModel = shortCpuModel(report.system.cpu_model);
  const runnerSub = `${cpuModel} \u00b7 ${report.system.cpu_count} vCPU \u00b7 ${fmtMem(report.system.total_memory_mb)}`;

  const cards = [
    { accent: '#3fb950', label: 'RUNNER', value: runnerValue, sub: runnerSub },
    { accent: '#58a6ff', label: 'DURATION', value: fmtDuration(report.duration_seconds), sub: `${report.started_at.slice(11, 19)} — ${report.ended_at.slice(11, 19)} UTC` },
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

function buildStatCardsImage(report: AggregatedReport): string {
  const config = buildStatCardsConfig(report);
  const url = chartGetUrl(config, 1024, 100);
  return `<img src="${url}" alt="Runner Stats" width="100%">`;
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

const STEP_LINE_COLOR = '#d0d7de';
const STEP_BAND_COLORS = [
  'rgba(47,129,247,0.10)',   // blue
  'rgba(63,185,80,0.10)',    // green
  'rgba(240,136,62,0.10)',   // orange
  'rgba(130,80,223,0.10)',   // purple
  'rgba(219,55,100,0.10)',   // pink
  'rgba(31,111,139,0.10)',   // teal
];

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildChartConfig(
  title: string,
  values: number[],
  labels: string[],
  lineColor: string,
  fillColor: string,
  yAxisLabel: string,
  extraLines?: { label: string; data: number[]; color: string }[],
): Record<string, any> {
  const extraDS = (extraLines ?? []).map(e => ({
    label: e.label,
    data: e.data,
    borderColor: e.color,
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.4,
    pointRadius: 0,
    borderWidth: 1.5,
    borderDash: [4, 3],
  }));
  const hasExtra = extraDS.length > 0;
  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: hasExtra ? 'total' : title,
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 2,
      }, ...extraDS],
    },
    options: {
      plugins: {
        legend: hasExtra
          ? { display: true, labels: { boxHeight: 0, boxWidth: 14, font: { size: 10 } } }
          : { display: false },
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

/**
 * Build a time-axis line chart as a raw JS string config (supports tick
 * callbacks). Uses the same pattern as buildGanttChartString.
 */
function buildSteppedChartString(
  title: string,
  dataPoints: { x: number; y: number }[],
  lineColor: string,
  fillColor: string,
  yAxisLabel: string,
  xMin: number,
  xMax: number,
  steps: { name: string; startMs: number; endMs: number }[],
  yMax?: number,
  extraLines?: { label: string; data: { x: number; y: number }[]; color: string }[],
): string {
  const data = JSON.stringify(dataPoints);
  const yValues = dataPoints.map(p => p.y);
  const dataMax = yValues.length > 0 ? Math.max(...yValues) : 100;
  const chartYMax = yMax ?? dataMax * 1.15;
  const xRange = xMax - xMin;

  const anns: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const m = steps[i];
    const name = escJs(m.name);
    const truncName = name.length > 20 ? name.slice(0, 17) + '...' : name;

    // Colored background band per step
    anns.push(`sb${i}:{type:'box',xMin:${m.startMs},xMax:${m.endMs},backgroundColor:'${STEP_BAND_COLORS[i % STEP_BAND_COLORS.length]}',borderWidth:0,drawTime:'beforeDatasetsDraw'}`);

    // Vertical dashed line at step start
    anns.push(`sl${i}:{type:'line',xMin:${m.startMs},xMax:${m.startMs},borderColor:'${STEP_LINE_COLOR}',borderWidth:1,borderDash:[4,4]}`);

    // Step name label — vertical, positioned in upper portion of band
    const midMs = (m.startMs + m.endMs) / 2;
    anns.push(`sn${i}:{type:'label',xValue:${midMs},yValue:${chartYMax * 0.62},content:['${truncName}'],color:'#1f2328',font:{size:9,weight:'bold'},rotation:-90,padding:{top:2,bottom:2,left:3,right:3},backgroundColor:'rgba(255,255,255,0.85)',borderRadius:3}`);
  }

  const extraDS = (extraLines ?? []).map(e =>
    `{label:'${escJs(e.label)}',data:${JSON.stringify(e.data)},borderColor:'${e.color}',backgroundColor:'transparent',fill:false,tension:0.4,pointRadius:0,borderWidth:1.5,borderDash:[4,3],clip:false}`
  );

  /* eslint-disable no-useless-escape */
  return `{
type:'line',
data:{datasets:[
  {label:'${extraDS.length > 0 ? 'total' : escJs(title)}',data:${data},borderColor:'${lineColor}',backgroundColor:'${fillColor}',fill:true,tension:0.4,pointRadius:0,borderWidth:2,clip:false}${extraDS.length > 0 ? ',' + extraDS.join(',') : ''}
]},
options:{
  plugins:{
    legend:{display:${extraDS.length > 0 ? 'true' : 'false'}${extraDS.length > 0 ? ",labels:{boxHeight:0,boxWidth:14,font:{size:10}}" : ''}},
    title:{display:true,text:'${escJs(title)}',color:'${TITLE_COLOR}',font:{size:14,weight:'bold'},padding:{bottom:12}},
    annotation:{annotations:{${anns.join(',')}}}
  },
  scales:{
    x:{
      type:'linear',min:${xMin - xRange * 0.01},max:${xMax + xRange * 0.01},
      ticks:{color:'${TICK}',font:{size:10},maxRotation:0,autoSkipPadding:20,
        callback:function(val){var d=new Date(val);return d.getUTCHours().toString().padStart(2,'0')+':'+d.getUTCMinutes().toString().padStart(2,'0')+':'+d.getUTCSeconds().toString().padStart(2,'0')}
      },
      grid:{display:false},
      border:{display:false}
    },
    y:{
      beginAtZero:true,max:${chartYMax},
      ticks:{color:'${TICK}',font:{size:11}},
      grid:{color:'#eff2f5'},
      border:{display:false},
      title:{display:true,text:'${yAxisLabel}',color:'${TICK}',font:{size:12}}
    }
  },
  layout:{padding:{top:12,right:16,bottom:4,left:4}}
}}`;
  /* eslint-enable no-useless-escape */
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ExtraLine {
  label: string;
  values: number[];
  color: string;
}

function buildQuickChart(
  title: string,
  values: number[],
  yLabel: string,
  lineColor: string,
  fillColor: string,
  startedAt: string,
  endedAt: string,
  steps?: { name: string; started_at: string; completed_at: string }[],
  yMax?: number,
  extraLines?: ExtraLine[],
): string {
  const maxPts = 30;
  const data = downsample(values, maxPts);
  const chartStartMs = new Date(startedAt).getTime();
  const chartEndMs = new Date(endedAt).getTime();

  const extras = (extraLines ?? []).map(l => ({
    label: l.label,
    data: downsample(l.values, maxPts),
    color: l.color,
  }));

  // ── Steps present: use linear time axis with step annotations ──
  if (steps && steps.length > 0) {
    const toXY = (d: number[]) => d.map((v, i) => ({
      x: chartStartMs + (chartEndMs - chartStartMs) * i / Math.max(d.length - 1, 1),
      y: v,
    }));
    const dataPoints = toXY(data);
    const extraXY = extras.map(e => ({ label: e.label, data: toXY(e.data), color: e.color }));

    const totalRange = chartEndMs - chartStartMs;
    const minStepMs = totalRange * 0.015;

    const toRegions = (s: typeof steps) => s
      .filter(st => st.started_at && st.completed_at)
      .map(st => {
        const sMs = new Date(st.started_at).getTime();
        const eMs = new Date(st.completed_at).getTime();
        return { name: st.name, startMs: sMs, endMs: eMs <= sMs ? sMs + minStepMs : eMs };
      });

    // Progressively keep only the longest-duration steps until URL fits.
    // Axis range is locked to the data range — step bands that extend
    // beyond the first/last sample are clipped by Chart.js, avoiding
    // empty space on either side of the chart.
    let visibleSteps = steps;
    while (visibleSteps.length > 0) {
      const regions = toRegions(visibleSteps);

      const chartStr = buildSteppedChartString(
        title, dataPoints, lineColor, fillColor, yLabel, chartStartMs, chartEndMs, regions, yMax, extraXY,
      );
      const url = chartGetUrl(chartStr, 1024, 300);
      if (url.length <= MAX_URL_LEN) {
        return `<img src="${url}" alt="${esc(title)}" width="100%">`;
      }
      visibleSteps = keepLongest(visibleSteps, Math.max(1, Math.floor(visibleSteps.length * 0.6)));
    }
  }

  // ── No steps: use category axis ──
  const labels = timeLabels(startedAt, endedAt, data.length);
  const extraCat = extras.map(e => ({ label: e.label, data: e.data, color: e.color }));
  const config = buildChartConfig(title, data, labels, lineColor, fillColor, yLabel, extraCat);
  const url = chartGetUrl(config, 1024, 250);
  return `<img src="${url}" alt="${esc(title)}" width="100%">`;
}

// ── Gantt Timeline (QuickChart.io horizontal bar chart) ──────

interface GanttJob {
  steps: { name: string; started_at: string; completed_at: string }[];
}

const GANTT_COLOR = '#2f81f7';

function collectGanttSteps(report: AggregatedReport): GanttJob | null {
  if (report.steps && report.steps.length > 0) {
    return { steps: report.steps };
  }
  return null;
}

function buildGanttChartString(ganttJob: GanttJob): string {
  interface Row { label: string; startMs: number; endMs: number; durStr: string }
  const rows: Row[] = [];

  for (const step of ganttJob.steps) {
    const name = step.name.length > 28 ? step.name.slice(0, 25) + '...' : step.name;
    const sMs = new Date(step.started_at).getTime();
    const eMs = new Date(step.completed_at).getTime();
    rows.push({ label: name, startMs: sMs, endMs: eMs, durStr: fmtDuration(Math.round((eMs - sMs) / 1000)) });
  }

  const globalMin = safeMin(rows.map((r) => r.startMs));
  const globalMax = safeMax(rows.map((r) => r.endMs));
  const range = globalMax - globalMin || 1;
  // Just enough to render a visible sliver for 0-duration steps
  const minBarWidth = range * 0.003;
  const durLabelPad = range * 0.10;

  const labels = JSON.stringify(rows.map((r) => r.label));
  const data = rows.map((r) => {
    const w = r.endMs - r.startMs;
    const end = w < minBarWidth ? r.startMs + minBarWidth : r.endMs;
    return `[${r.startMs},${end}]`;
  }).join(',');
  const bgColors = JSON.stringify(rows.map(() => GANTT_COLOR));

  const anns: string[] = [];

  // Alternating row backgrounds
  for (let i = 0; i < rows.length; i++) {
    anns.push(`tr${i}:{type:'box',drawTime:'beforeDatasetsDraw',xMin:${globalMin},xMax:${globalMax},yMin:${i - 0.5},yMax:${i + 0.5},backgroundColor:'${i % 2 === 0 ? '#f6f8fa' : '#eff2f5'}',borderWidth:0}`);
  }

  // Duration labels on right
  for (let i = 0; i < rows.length; i++) {
    anns.push(`du${i}:{type:'label',drawTime:'afterDatasetsDraw',xValue:${globalMax + durLabelPad * 0.5},yValue:${i},content:['${rows[i].durStr}'],color:'${TICK}',font:{size:10}}`);
  }

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
      ticks:{color:'${TICK}',font:{size:11},padding:6},
      grid:{display:false},
      border:{display:false}
    }
  },
  layout:{padding:{right:8,left:4,top:4,bottom:4}}
}}`;
  /* eslint-enable no-useless-escape */
}

function buildGanttChart(ganttJob: GanttJob): string {
  // Progressively keep only the longest-duration steps until URL fits.
  let steps = ganttJob.steps;
  while (steps.length > 0) {
    const height = Math.max(160, Math.min(700, 56 + steps.length * 26));
    const url = chartGetUrl(buildGanttChartString({ steps }), 1024, height);
    if (url.length <= MAX_URL_LEN) {
      return `<img src="${url}" alt="Execution Timeline" width="100%">`;
    }
    steps = keepLongest(steps, Math.max(1, Math.floor(steps.length * 0.6)));
  }
  return '';
}

// ── Helpers: per-job section ─────────────────────────────────

function buildJobSection(report: AggregatedReport, sampleInterval: number): string {
  const parts: string[] = [];

  // Stat cards
  try {
    parts.push(buildStatCardsImage(report));
  } catch {
    parts.push('> **RunnerLens:** unable to generate stat cards chart');
  }

  // CPU + Memory charts
  // Filter out steps whose duration is <= the scrape interval
  // (they are too short to meaningfully display on the chart)
  const chartSteps = report.steps?.filter(s => {
    const durSec = (new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1000;
    return durSec > sampleInterval;
  });
  const timeline = report.timeline;
  if (timeline && timeline.cpu_pct.length >= 2) {
    try {
      parts.push(buildQuickChart(
        'CPU Usage (%)', timeline.cpu_pct, 'CPU %',
        CPU_COLOR, CPU_FILL,
        report.started_at, report.ended_at,
        chartSteps, 100,
        [
          { label: 'user', values: timeline.cpu_user, color: CPU_USER_COLOR },
          { label: 'nice', values: timeline.cpu_nice, color: '#d2a8ff' },
          { label: 'system', values: timeline.cpu_system, color: CPU_SYS_COLOR },
        ],
      ));
      const toGb = (v: number) => Math.round((v / 1024) * 100) / 100;
      const memGb = timeline.mem_mb.map(toGb);
      parts.push(buildQuickChart(
        'Memory Usage (GB)', memGb, 'GB',
        MEM_COLOR, MEM_FILL,
        report.started_at, report.ended_at,
        chartSteps, toGb(report.memory.total_mb),
        [
          { label: 'cached', values: timeline.mem_cached_mb.map(toGb), color: MEM_CACHED_COLOR },
          { label: 'swap', values: timeline.mem_swap_mb.map(toGb), color: MEM_SWAP_COLOR },
        ],
      ));
    } catch {
      parts.push('> **RunnerLens:** unable to generate CPU/Memory charts');
    }
  }

  return parts.join('\n\n');
}

// ── Public API ───────────────────────────────────────────────

export function buildJobSummary(report: AggregatedReport, sampleInterval: number): string {
  const parts: string[] = [];

  parts.push(buildJobSection(report, sampleInterval));

  // Gantt timeline
  const ganttJob = collectGanttSteps(report);
  if (ganttJob) {
    try {
      parts.push(buildGanttChart(ganttJob));
    } catch {
      parts.push('> **RunnerLens:** unable to generate execution timeline chart');
    }
  }

  parts.push(
    `<sub>Generated by <a href="https://github.com/runnerlens/runner-lens">RunnerLens</a> v${REPORT_VERSION}</sub>`,
  );

  return parts.join('\n\n');
}
