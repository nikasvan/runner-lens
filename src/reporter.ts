import type {
  MetricSample, SystemInfo,
  AggregatedReport, StepMetrics,
} from './types';
import { stats, safeMax } from './stats';
import { REPORT_VERSION } from './constants';

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
    cpu_pct: samples.map(s => s.cpu.usage),
    cpu_user: samples.map(s => s.cpu.user),
    cpu_system: samples.map(s => s.cpu.system),
    mem_mb: samples.map(s => s.memory.used_mb),
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
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(timeline ? { timeline } : {}),
    ...(collector ? { collector } : {}),
  };

  return report;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export function processMetrics(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  durationSec: number,
  steps?: StepMetrics[],
): {
  report: AggregatedReport;
} {
  const report = aggregate(samples, sysInfo, durationSec, steps);
  return { report };
}
