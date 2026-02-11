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
  if (cpuStats.p95 >= t.cpu_crit) {
    alerts.push({
      level: 'critical', metric: 'CPU',
      message: `p95 CPU at ${cpuStats.p95.toFixed(1)}% exceeds critical threshold ${t.cpu_crit}%`,
      value: cpuStats.p95, threshold: t.cpu_crit,
    });
  } else if (cpuStats.p95 >= t.cpu_warn) {
    alerts.push({
      level: 'warning', metric: 'CPU',
      message: `p95 CPU at ${cpuStats.p95.toFixed(1)}% exceeds warning threshold ${t.cpu_warn}%`,
      value: cpuStats.p95, threshold: t.cpu_warn,
    });
  }

  // ── Memory ──────────────────────────────────────────────
  const memP95Pct = safePct(memStats.p95, memTotalMb);
  if (memP95Pct >= t.mem_crit) {
    alerts.push({
      level: 'critical', metric: 'Memory',
      message: `p95 memory at ${memP95Pct.toFixed(1)}% (${memStats.p95.toFixed(0)}/${memTotalMb} MB)`,
      value: memP95Pct, threshold: t.mem_crit,
    });
  } else if (memP95Pct >= t.mem_warn) {
    alerts.push({
      level: 'warning', metric: 'Memory',
      message: `p95 memory at ${memP95Pct.toFixed(1)}% (${memStats.p95.toFixed(0)}/${memTotalMb} MB)`,
      value: memP95Pct, threshold: t.mem_warn,
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
