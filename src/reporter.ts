import type {
  MetricSample, SystemInfo, MonitorConfig,
  AggregatedReport, ProcessInfo, StepMetrics,
} from './types';
import { stats, safeMax, safePct } from './stats';
import { fmtDuration } from './charts';
import {
  resolvedSvg, statCards, timelineChart, stepBarChart,
} from './svg-charts';
import {
  statCardChartUrl, timelineChartUrl, barChartUrl,
} from './quickchart';
import { REPORT_VERSION } from './constants';

const TIMELINE_POINTS = 80;

function downsample(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, values.length - 1);
    const frac = pos - lo;
    out.push(+(values[lo] * (1 - frac) + values[hi] * frac).toFixed(1));
  }
  return out;
}

function aggregate(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  durationSec: number,
  steps?: StepMetrics[],
): AggregatedReport {
  const cpuStats = stats(samples.map((s) => s.cpu.usage));
  const memStats = stats(samples.map((s) => s.memory.used_mb));
  const memTotal = samples[0]?.memory.total_mb ?? 0;
  const swapMax  = safeMax(samples.map((s) => s.memory.swap_used_mb));

  const loadVals = samples.map((s) => s.load?.load1 ?? 0);
  const loadAvg  = loadVals.length > 0
    ? loadVals.reduce((a, b) => a + b, 0) / loadVals.length
    : 0;

  const procMap = new Map<string, ProcessInfo>();
  for (const s of samples) {
    for (const p of s.processes ?? []) {
      const cur = procMap.get(p.name);
      if (!cur || p.cpu_pct > cur.cpu_pct) procMap.set(p.name, p);
    }
  }
  const topProcs = [...procMap.values()].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 10);

  const last = samples[samples.length - 1];

  // ── Collector self-monitoring stats ─────────────────────
  const collSamples = samples.filter((s) => s.collector);
  let collector: AggregatedReport['collector'];
  if (collSamples.length > 0) {
    const cpuVals = collSamples.map((s) => s.collector!.cpu_pct);
    const memVals = collSamples.map((s) => s.collector!.mem_mb);
    collector = {
      avg_cpu_pct: cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length,
      avg_mem_mb: memVals.reduce((a, b) => a + b, 0) / memVals.length,
      max_mem_mb: safeMax(memVals),
    };
  }

  const timeline = samples.length >= 2 ? {
    cpu_pct: downsample(samples.map(s => s.cpu.usage), TIMELINE_POINTS),
    mem_mb: downsample(samples.map(s => s.memory.used_mb), TIMELINE_POINTS),
  } : undefined;

  const report: AggregatedReport = {
    version: REPORT_VERSION,
    system: sysInfo,
    duration_seconds: durationSec,
    sample_count: samples.length,
    started_at: new Date(samples[0].timestamp * 1000).toISOString(),
    ended_at:   new Date(last.timestamp * 1000).toISOString(),
    cpu: cpuStats,
    memory: { ...memStats, total_mb: memTotal, swap_max_mb: swapMax },
    load: {
      avg_1m: loadAvg,
      max_1m: safeMax(loadVals),
    },
    top_processes: topProcs,
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(timeline ? { timeline } : {}),
    ...(collector ? { collector } : {}),
  };

  return report;
}

// ─────────────────────────────────────────────────────────────
// Generate SVG charts for upload (raw SVG strings)
// ─────────────────────────────────────────────────────────────

function generateSvgCharts(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
): Record<string, string> {
  const charts: Record<string, string> = {};
  const minimal = config.summaryStyle === 'minimal';
  const sys = report.system;

  const cpuAvgPct = report.cpu.avg;
  const cpuPeakPct = report.cpu.max;
  const memAvgPct = safePct(report.memory.avg, report.memory.total_mb);
  const memPeakPct = safePct(report.memory.max, report.memory.total_mb);

  // Stat cards
  charts['stat-cards'] = resolvedSvg(statCards([
    { label: 'Runner', value: `${sys.cpu_count} × ${sys.cpu_model}`, sub: `${(sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${sys.runner_os}`, colorVar: 'muted' },
    { label: 'Duration', value: fmtDuration(report.duration_seconds), sub: `${report.sample_count} samples`, colorVar: 'accent-cyan' },
    { label: 'Avg CPU', value: `${cpuAvgPct.toFixed(0)}%`, sub: `peak ${cpuPeakPct.toFixed(0)}%`, colorVar: 'accent-blue' },
    { label: 'Memory', value: `${memAvgPct.toFixed(0)}% avg`, sub: `peak ${memPeakPct.toFixed(0)}% · ${(report.memory.max / 1024).toFixed(1)} GB`, colorVar: 'accent-purple' },
  ]));

  // Per-step bar chart
  if (report.steps && report.steps.length > 0) {
    const svg = stepBarChart(
      report.steps.map(s => ({ name: s.name, value: s.duration_seconds })),
      { formatValue: fmtDuration },
    );
    if (svg) charts['step-chart'] = resolvedSvg(svg);
  }

  // Timeline chart
  if (!minimal) {
    const cpuV = samples.map(s => s.cpu.usage);
    const memV = samples.map(s => s.memory.usage_pct);
    if (cpuV.length >= 4) {
      const svg = timelineChart(cpuV, memV, {
        cpuAvg: cpuAvgPct,
        memAvg: memAvgPct,
      });
      if (svg) charts['timeline'] = resolvedSvg(svg);
    }
  }

  return charts;
}

// ─────────────────────────────────────────────────────────────
// Generate quickchart.io image URLs for GitHub Job Summary
// GitHub strips both inline <svg> and data: URIs; only https://
// image URLs are allowed. quickchart.io renders Chart.js configs
// as PNG images on-the-fly via GET URLs — no API key required.
// ─────────────────────────────────────────────────────────────

function generateQuickchartImgs(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
): Record<string, string> {
  const imgs: Record<string, string> = {};
  const minimal = config.summaryStyle === 'minimal';
  const sys = report.system;

  const cpuAvgPct = report.cpu.avg;
  const cpuPeakPct = report.cpu.max;
  const memAvgPct = safePct(report.memory.avg, report.memory.total_mb);
  const memPeakPct = safePct(report.memory.max, report.memory.total_mb);

  // Stat cards
  const statUrl = statCardChartUrl({
    runner: `${sys.cpu_count} × ${sys.cpu_model}`,
    runnerSub: `${(sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${sys.runner_os}`,
    duration: fmtDuration(report.duration_seconds),
    samples: report.sample_count,
    cpuAvg: cpuAvgPct,
    cpuPeak: cpuPeakPct,
    memAvgPct,
    memPeakPct,
    memPeakGb: `${(report.memory.max / 1024).toFixed(1)} GB`,
  });
  imgs['stat-cards'] = `<img src="${statUrl}" alt="Stats" width="600" height="120" />`;

  // Per-step bar chart
  if (report.steps && report.steps.length > 0) {
    const barUrl = barChartUrl(
      report.steps.map(s => ({ name: s.name, durationSec: s.duration_seconds })),
    );
    const h = Math.max(100, report.steps.length * 28 + 30);
    imgs['step-chart'] = `<img src="${barUrl}" alt="Per-step durations" width="600" height="${h}" />`;
  }

  // Timeline chart
  if (!minimal) {
    const cpuV = samples.map(s => s.cpu.usage);
    const memV = samples.map(s => s.memory.usage_pct);
    if (cpuV.length >= 4) {
      const tlUrl = timelineChartUrl(cpuV, memV, {
        cpuAvg: cpuAvgPct,
        memAvg: memAvgPct,
      });
      imgs['timeline'] = `<img src="${tlUrl}" alt="CPU &amp; Memory Timeline" width="600" height="200" />`;
    }
  }

  return imgs;
}

// ─────────────────────────────────────────────────────────────
// Markdown builder
// Uses uploaded SVG URLs if available, otherwise falls back to
// quickchart.io PNG image URLs. Both produce <img src="https://...">
// tags which GitHub Job Summary renders correctly.
// ─────────────────────────────────────────────────────────────

/** Build an <img> tag for a chart, preferring uploaded URL over quickchart fallback. */
function chartImg(
  uploadedUrls: Record<string, string>,
  key: string,
  quickchartFallback: string | undefined,
  alt: string,
  width: number,
  height: number,
): string | undefined {
  const url = uploadedUrls[key] ?? quickchartFallback;
  if (!url) return undefined;
  return `<img src="${url}" alt="${alt}" width="${width}" height="${height}" />`;
}

function markdown(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
  uploadedUrls: Record<string, string> = {},
): string {
  const L: string[] = [];

  // Generate quickchart fallback URLs
  const qc = generateQuickchartImgs(report, samples, config);

  // ── Header ──────────────────────────────────────────────
  L.push('## 📊 RunnerLens\n');

  // ── Stat cards ─────────────────────────────────────────
  const statImg = chartImg(uploadedUrls, 'stat-cards', qc['stat-cards'], 'Stats', 600, 120);
  if (statImg) L.push(statImg + '\n');

  // ── Per-step bar chart ─────────────────────────────────
  const stepH = report.steps ? Math.max(100, report.steps.length * 28 + 30) : 200;
  const stepImg = chartImg(uploadedUrls, 'step-chart', qc['step-chart'], 'Per-step durations', 600, stepH);
  if (stepImg) {
    L.push('### Steps\n');
    L.push(stepImg + '\n');
  }

  // ── Timeline ──────────────────────────────────────────
  const tlImg = chartImg(uploadedUrls, 'timeline', qc['timeline'], 'CPU &amp; Memory Timeline', 600, 172);
  if (tlImg) {
    L.push('### Timeline\n');
    L.push(tlImg + '\n');
  }

  // ── Footer ─────────────────────────────────────────────
  L.push('---');
  const collectorInfo = report.collector
    ? ` · Sampling: ${report.collector.avg_cpu_pct.toFixed(1)}% CPU · ${report.collector.avg_mem_mb.toFixed(1)} MB RAM`
    : '';
  const reporterInfo = report.reporter
    ? ` · Reporting: ${report.reporter.cpu_pct.toFixed(1)}% CPU · ${report.reporter.mem_mb.toFixed(1)} MB RAM`
    : '';
  L.push(
    `<sub><a href="https://runnerlens.com">RunnerLens</a> ` +
    `v${REPORT_VERSION} · ${report.started_at} → ${report.ended_at}${collectorInfo}${reporterInfo}</sub>`,
  );

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export function processMetrics(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  config: MonitorConfig,
  durationSec: number,
  steps?: StepMetrics[],
): {
  report: AggregatedReport;
  charts: Record<string, string>;    // Raw SVG strings for upload
} {
  const report = aggregate(samples, sysInfo, durationSec, steps);
  if (config.summaryStyle === 'none') {
    return { report, charts: {} };
  }
  const charts = generateSvgCharts(report, samples, config);
  return { report, charts };
}

/**
 * Build the per-job markdown summary.
 * Uses uploaded SVG URLs when available (producing <img src="https://...">),
 * falling back to quickchart.io PNG image URLs.
 * Both approaches produce https:// URLs that GitHub Job Summary renders.
 */
export function buildJobMarkdown(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
  uploadedUrls: Record<string, string> = {},
): string {
  if (config.summaryStyle === 'none') return '';
  return markdown(report, samples, config, uploadedUrls);
}
