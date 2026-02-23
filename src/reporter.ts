import type {
  MetricSample, SystemInfo, MonitorConfig,
  AggregatedReport, ProcessInfo, StepMetrics,
} from './types';
import { stats, safeMax, safePct } from './stats';
import { fmtDuration } from './charts';
import { htmlStatCards, htmlBarChart, htmlTimeline } from './html-charts';
import { timelineChartUrl, barChartUrl } from './quickchart';
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
// Generate quickchart.io URLs for charts
// ─────────────────────────────────────────────────────────────

function generateChartUrls(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
): Record<string, string> {
  const urls: Record<string, string> = {};
  const minimal = config.summaryStyle === 'minimal';

  const cpuAvgPct = report.cpu.avg;
  const memAvgPct = safePct(report.memory.avg, report.memory.total_mb);

  // Per-step bar chart
  if (report.steps && report.steps.length > 0) {
    urls['step-chart'] = barChartUrl(
      report.steps.map(s => ({ name: s.name, durationSec: s.duration_seconds })),
    );
  }

  // Timeline chart
  if (!minimal) {
    const cpuV = samples.map(s => s.cpu.usage);
    const memV = samples.map(s => s.memory.usage_pct);
    if (cpuV.length >= 4) {
      urls['timeline'] = timelineChartUrl(cpuV, memV, {
        cpuAvg: cpuAvgPct,
        memAvg: memAvgPct,
      });
    }
  }

  return urls;
}

// ─────────────────────────────────────────────────────────────
// Markdown builder
// ─────────────────────────────────────────────────────────────

function markdown(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
  chartUrls: Record<string, string>,
): string {
  const minimal = config.summaryStyle === 'minimal';
  const L: string[] = [];

  const cpuAvgPct = report.cpu.avg;
  const cpuPeakPct = report.cpu.max;
  const memAvgPct = safePct(report.memory.avg, report.memory.total_mb);
  const memPeakPct = safePct(report.memory.max, report.memory.total_mb);

  const sys = report.system;

  // ── Header ──────────────────────────────────────────────
  L.push('## 📊 RunnerLens\n');

  // ── Stat cards (HTML table) ────────────────────────────
  L.push(htmlStatCards([
    { label: 'Runner', value: `${sys.cpu_count} × ${sys.cpu_model}`, sub: `${(sys.total_memory_mb / 1024).toFixed(1)} GB RAM · ${sys.runner_os}` },
    { label: 'Duration', value: fmtDuration(report.duration_seconds), sub: `${report.sample_count} samples` },
    { label: 'Avg CPU', value: `${cpuAvgPct.toFixed(0)}%`, sub: `peak ${cpuPeakPct.toFixed(0)}%` },
    { label: 'Memory', value: `${memAvgPct.toFixed(0)}% avg`, sub: `peak ${memPeakPct.toFixed(0)}% · ${(report.memory.max / 1024).toFixed(1)} GB` },
  ]) + '\n');

  // ── Per-step breakdown ────────────────────────────────
  if (report.steps && report.steps.length > 0) {
    L.push('<details open><summary><strong>📋 Per-Step Breakdown</strong></summary>\n');

    if (chartUrls['step-chart']) {
      L.push(`\n<img src="${chartUrls['step-chart']}" alt="Per-step duration chart" width="600">\n`);
    } else {
      L.push(htmlBarChart(
        report.steps.map((s) => ({ label: s.name, value: s.duration_seconds })),
        { formatValue: fmtDuration },
      ));
      L.push('');
    }

    L.push('| # | Step | Duration | CPU avg | CPU peak | Mem avg | Mem peak |');
    L.push('|---:|---|---:|---:|---:|---:|---:|');
    for (const s of report.steps) {
      const memAvgGB = (s.mem_avg_mb / 1024).toFixed(1);
      const memMaxGB = (s.mem_max_mb / 1024).toFixed(1);
      L.push(
        `| ${s.number} ` +
        `| ${s.name} ` +
        `| ${fmtDuration(s.duration_seconds)} ` +
        `| ${s.cpu_avg.toFixed(0)}% ` +
        `| ${s.cpu_max.toFixed(0)}% ` +
        `| ${memAvgGB} GB ` +
        `| ${memMaxGB} GB |`,
      );
    }
    L.push('\n</details>\n');
  }

  // ── Timeline ──────────────────────────────────────────
  if (!minimal) {
    if (chartUrls['timeline']) {
      L.push('<details open><summary><strong>📈 Timeline</strong></summary>\n');
      L.push(`\n<img src="${chartUrls['timeline']}" alt="CPU and Memory timeline" width="600">`);
      L.push('\n</details>\n');
    } else {
      const cpuV = samples.map((s) => s.cpu.usage);
      const memV = samples.map((s) => s.memory.usage_pct);
      if (cpuV.length >= 4) {
        L.push('<details open><summary><strong>📈 Timeline</strong></summary>\n');
        L.push(htmlTimeline([
          { label: 'CPU', values: cpuV, avg: `${cpuAvgPct.toFixed(0)}% avg` },
          { label: 'Memory', values: memV, avg: `${memAvgPct.toFixed(0)}% avg` },
        ]));
        L.push('\n</details>\n');
      }
    }
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
): { report: AggregatedReport; chartUrls: Record<string, string> } {
  const report = aggregate(samples, sysInfo, durationSec, steps);
  const chartUrls = config.summaryStyle === 'none'
    ? {}
    : generateChartUrls(report, samples, config);
  return { report, chartUrls };
}

/**
 * Build the per-job markdown summary.
 * Uses quickchart.io image URLs for charts, HTML tables for stat cards.
 */
export function buildJobMarkdown(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
  chartUrls?: Record<string, string>,
): string {
  if (config.summaryStyle === 'none') return '';
  return markdown(report, samples, config, chartUrls ?? {});
}
