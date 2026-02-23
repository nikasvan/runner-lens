// ─────────────────────────────────────────────────────────────
// RunnerLens — Charts & Formatting
// ─────────────────────────────────────────────────────────────

/** Format seconds into "1h 23m 4s". */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
