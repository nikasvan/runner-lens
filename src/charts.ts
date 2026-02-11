// ─────────────────────────────────────────────────────────────
// RunnerLens — ASCII Charts & Formatting
// ─────────────────────────────────────────────────────────────

const SPARKS = '▁▂▃▄▅▆▇█';

/** Down-sample values to ≤ width points using linear interpolation. */
function resample(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (width - 1);
  for (let i = 0; i < width; i++) {
    const pos  = i * step;
    const lo   = Math.floor(pos);
    const hi   = Math.min(lo + 1, values.length - 1);
    const frac = pos - lo;
    out.push(values[lo] * (1 - frac) + values[hi] * frac);
  }
  return out;
}

/** Render a sparkline string from numeric values. */
export function sparkline(values: number[], width = 60): string {
  if (values.length < 2) return '';
  const rs = resample(values, width);
  let min = rs[0], max = rs[0];
  for (let i = 1; i < rs.length; i++) {
    if (rs[i] < min) min = rs[i];
    if (rs[i] > max) max = rs[i];
  }
  const span = max - min || 1;
  return rs
    .map((v) => {
      const idx = Math.round(((v - min) / span) * (SPARKS.length - 1));
      return SPARKS[Math.max(0, Math.min(idx, SPARKS.length - 1))];
    })
    .join('');
}

/** Render a simple intensity bar (for % values 0–100). */
export function intensityBar(values: number[], width = 60): string {
  if (values.length < 2) return '';
  return resample(values, width)
    .map((v) => {
      const n = Math.min(v, 100) / 100;
      if (n > 0.80) return '█';
      if (n > 0.60) return '▓';
      if (n > 0.40) return '▒';
      if (n > 0.20) return '░';
      return '·';
    })
    .join('');
}

/**
 * Visual progress bar for use in markdown tables.
 * e.g. progressBar(65, 15) → "█████████░░░░░░"
 */
export function progressBar(pct: number, width = 15): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Status dot based on percentage thresholds. */
export function statusDot(pct: number, warn = 80, crit = 95): string {
  if (pct >= crit) return '🔴';
  if (pct >= warn) return '🟡';
  return '🟢';
}

/** Format bytes into a human-readable string. */
export function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), u.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

/** Format seconds into "1h 23m 4s". */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
