import type { MetricSample, MetricStats, MonitorConfig, Alert } from './types';
import { safeMax, safePct } from './stats';

export function evaluateAlerts(
  samples: MetricSample[],
  config: MonitorConfig,
  cpuStats: MetricStats,
  memStats: MetricStats,
  memTotalMb: number,
): Alert[] {
  const { thresholds: t } = config;
  const alerts: Alert[] = [];

  if (samples.length === 0) return alerts;

  // ── CPU ─────────────────────────────────────────────────
  if (cpuStats.avg >= t.cpu_crit) {
    alerts.push({
      level: 'critical', metric: 'CPU',
      message: `Average CPU at ${cpuStats.avg.toFixed(1)}% exceeds critical threshold ${t.cpu_crit}%`,
      value: cpuStats.avg, threshold: t.cpu_crit,
    });
  } else if (cpuStats.avg >= t.cpu_warn) {
    alerts.push({
      level: 'warning', metric: 'CPU',
      message: `Average CPU at ${cpuStats.avg.toFixed(1)}% exceeds warning threshold ${t.cpu_warn}%`,
      value: cpuStats.avg, threshold: t.cpu_warn,
    });
  }

  // ── Memory ──────────────────────────────────────────────
  const memAvgPct = safePct(memStats.avg, memTotalMb);
  if (memAvgPct >= t.mem_crit) {
    alerts.push({
      level: 'critical', metric: 'Memory',
      message: `Average memory at ${memAvgPct.toFixed(1)}% (${memStats.avg.toFixed(0)}/${memTotalMb} MB)`,
      value: memAvgPct, threshold: t.mem_crit,
    });
  } else if (memAvgPct >= t.mem_warn) {
    alerts.push({
      level: 'warning', metric: 'Memory',
      message: `Average memory at ${memAvgPct.toFixed(1)}% (${memStats.avg.toFixed(0)}/${memTotalMb} MB)`,
      value: memAvgPct, threshold: t.mem_warn,
    });
  }

  // ── Swap pressure (stack-safe max) ──────────────────────
  const swapValues = samples.map((s) => s.memory.swap_used_mb);
  const swapCount = swapValues.filter((v) => v > 0).length;
  if (swapCount > samples.length * 0.1) {
    const maxSwap = safeMax(swapValues);
    alerts.push({
      level: 'warning', metric: 'Swap',
      message: `Swap in use (peak ${maxSwap} MB) — possible memory pressure`,
      value: maxSwap, threshold: 0,
    });
  }

  // ── I/O wait ────────────────────────────────────────────
  const avgIoWait = samples.reduce((s, x) => s + x.cpu.iowait, 0) / samples.length;
  if (avgIoWait > 20) {
    alerts.push({
      level: 'warning', metric: 'I/O Wait',
      message: `Average I/O wait ${avgIoWait.toFixed(1)}% — possible disk bottleneck`,
      value: avgIoWait, threshold: 20,
    });
  }

  // ── CPU steal (cloud throttling) ────────────────────────
  const avgSteal = samples.reduce((s, x) => s + (x.cpu.steal ?? 0), 0) / samples.length;
  if (avgSteal > 5) {
    alerts.push({
      level: 'warning', metric: 'CPU Steal',
      message: `Average CPU steal ${avgSteal.toFixed(1)}% — host may be over-committed`,
      value: avgSteal, threshold: 5,
    });
  }

  return alerts;
}
