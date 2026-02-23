// ─────────────────────────────────────────────────────────────
// RunnerLens — QuickChart.io URL Builders
//
// Generates permanent chart image URLs via quickchart.io.
// Chart config is encoded in the GET URL itself — no API calls,
// no uploads, no tokens needed. Images render on-the-fly as SVG.
// ─────────────────────────────────────────────────────────────

import { fmtDuration } from './charts';

const QC_BASE = 'https://quickchart.io/chart';

// ── Dark theme colors (matching our SVG palette) ────────────

const C = {
  bg: '#0d1117',
  fg: '#e6edf3',
  muted: '#8b949e',
  grid: '#21262d',
  cpu: '#58a6ff',
  cpuFill: 'rgba(88,166,255,0.15)',
  mem: '#bc8cff',
  memFill: 'rgba(188,140,255,0.15)',
  bar: '#58a6ff',
  jobs: ['#58a6ff', '#bc8cff', '#39d2c0', '#3fb950'],
};

// ── Helpers ─────────────────────────────────────────────────

function round(values: number[]): number[] {
  return values.map(v => Math.round(v));
}

function downsample(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, values.length - 1);
    const frac = pos - lo;
    out.push(Math.round(values[lo] * (1 - frac) + values[hi] * frac));
  }
  return out;
}

/** Build a quickchart.io GET URL from a Chart.js config string. */
function makeUrl(
  config: string,
  opts: { width?: number; height?: number } = {},
): string {
  const w = opts.width ?? 600;
  const h = opts.height ?? 200;
  return `${QC_BASE}?c=${encodeURIComponent(config)}&w=${w}&h=${h}&bkg=${encodeURIComponent(C.bg)}&f=svg`;
}

// ── Per-job Timeline (CPU + Memory area chart) ──────────────

export function timelineChartUrl(
  cpuValues: number[],
  memValues: number[],
  opts: { cpuAvg?: number; memAvg?: number } = {},
): string {
  const cpu = round(downsample(cpuValues, 40));
  const mem = round(downsample(memValues, 40));

  const cpuLabel = opts.cpuAvg !== undefined ? `CPU ${opts.cpuAvg.toFixed(0)}% avg` : 'CPU %';
  const memLabel = opts.memAvg !== undefined ? `Mem ${opts.memAvg.toFixed(0)}% avg` : 'Mem %';

  const config = JSON.stringify({
    type: 'line',
    data: {
      labels: cpu.map((_, i) => i),
      datasets: [
        {
          label: cpuLabel,
          data: cpu,
          borderColor: C.cpu,
          backgroundColor: C.cpuFill,
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
          lineTension: 0.3,
        },
        {
          label: memLabel,
          data: mem,
          borderColor: C.mem,
          backgroundColor: C.memFill,
          fill: true,
          pointRadius: 0,
          borderWidth: 1.5,
          lineTension: 0.3,
        },
      ],
    },
    options: {
      scales: {
        yAxes: [{ ticks: { min: 0, max: 100, fontColor: C.muted }, gridLines: { color: C.grid } }],
        xAxes: [{ display: false }],
      },
      legend: { labels: { fontColor: C.fg, boxWidth: 12 } },
    },
  });

  return makeUrl(config);
}

// ── Step Duration Bar Chart ─────────────────────────────────

export function barChartUrl(
  steps: Array<{ name: string; durationSec: number }>,
): string {
  const labels = steps.map(s => {
    const dur = fmtDuration(s.durationSec);
    const name = s.name.length > 20 ? s.name.slice(0, 19) + '…' : s.name;
    return `${name} (${dur})`;
  });
  const data = steps.map(s => s.durationSec);

  const config = JSON.stringify({
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: C.bar }],
    },
    options: {
      scales: {
        xAxes: [{ display: false }],
        yAxes: [{ ticks: { fontColor: C.fg, fontSize: 11 }, gridLines: { display: false } }],
      },
      legend: { display: false },
    },
  });

  const h = Math.max(100, steps.length * 28 + 30);
  return makeUrl(config, { height: h });
}

// ── Waterfall / Gantt Chart ─────────────────────────────────

export function waterfallChartUrl(
  steps: Array<{ job: string; step: string; startSec: number; durationSec: number }>,
): string {
  // Assign colors per job
  const jobColors = new Map<string, string>();
  let colorIdx = 0;
  for (const s of steps) {
    if (!jobColors.has(s.job)) {
      jobColors.set(s.job, C.jobs[colorIdx % C.jobs.length]);
      colorIdx++;
    }
  }

  const labels = steps.map(s => {
    const step = s.step.length > 16 ? s.step.slice(0, 15) + '…' : s.step;
    const job = s.job.length > 8 ? s.job.slice(0, 7) + '…' : s.job;
    return `${job} · ${step}`;
  });

  const data = steps.map(s => [Math.round(s.startSec), Math.round(s.startSec + s.durationSec)]);
  const colors = steps.map(s => jobColors.get(s.job)!);

  const config = JSON.stringify({
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors }],
    },
    options: {
      scales: {
        xAxes: [{ ticks: { fontColor: C.muted }, gridLines: { color: C.grid } }],
        yAxes: [{ ticks: { fontColor: C.fg, fontSize: 10 }, gridLines: { display: false } }],
      },
      legend: { display: false },
    },
  });

  const h = Math.max(100, steps.length * 24 + 40);
  return makeUrl(config, { height: h });
}

// ── Workflow Timeline (single-series: CPU or Memory) ────────

export function workflowTimelineUrl(
  values: number[],
  opts: {
    color: string;
    fillColor: string;
    label: string;
    yMax: number;
  },
): string {
  const ds = round(downsample(values, 50));

  const config = JSON.stringify({
    type: 'line',
    data: {
      labels: ds.map((_, i) => i),
      datasets: [{
        label: opts.label,
        data: ds,
        borderColor: opts.color,
        backgroundColor: opts.fillColor,
        fill: true,
        pointRadius: 0,
        borderWidth: 1.5,
        lineTension: 0.3,
      }],
    },
    options: {
      scales: {
        yAxes: [{ ticks: { min: 0, max: Math.ceil(opts.yMax), fontColor: C.muted }, gridLines: { color: C.grid } }],
        xAxes: [{ display: false }],
      },
      legend: { labels: { fontColor: C.fg, boxWidth: 12 } },
    },
  });

  return makeUrl(config, { height: 160 });
}
