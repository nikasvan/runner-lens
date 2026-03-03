import type { MetricStats } from './types';

export function stats(values: number[]): MetricStats {
  if (values.length === 0) {
    return { avg: 0, max: 0, min: 0, latest: 0 };
  }
  let sum = 0;
  let min = values[0];
  let max = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    avg:    sum / values.length,
    min,
    max,
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
