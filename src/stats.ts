import type { MetricStats } from './types';

/**
 * Nearest-rank percentile. For P0 returns the smallest element, for P100
 * the largest. This matches the "ceiling" variant of the nearest-rank
 * method (used by Excel's PERCENTILE.INC).
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function stats(values: number[]): MetricStats {
  if (values.length === 0) {
    return { avg: 0, max: 0, min: 0, p50: 0, p95: 0, p99: 0, latest: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((s, v) => s + v, 0);
  return {
    avg:    sum / values.length,
    min:    sorted[0],
    max:    sorted[sorted.length - 1],
    p50:    percentile(sorted, 50),
    p95:    percentile(sorted, 95),
    p99:    percentile(sorted, 99),
    latest: values[values.length - 1],
  };
}

/**
 * Stack-safe max. `Math.max(...arr)` throws RangeError when arr > ~65k elements.
 * After rotation fix we can easily have 100k+ samples.
 */
export function safeMax(values: number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  let m = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > m) m = values[i];
  }
  return m;
}

/** Stack-safe min. Mirrors safeMax. */
export function safeMin(values: number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  let m = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < m) m = values[i];
  }
  return m;
}

/** Safe division — returns 0 when divisor is 0. */
export function safePct(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
