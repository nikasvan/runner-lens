// ─────────────────────────────────────────────────────────────
// RunnerLens — Dark-Themed SVG Chart Rendering
//
// Strategy: Render charts as SVG, convert to PNG via @resvg/resvg-js
// (pure npm, no system deps), embed as data:image/png;base64
// which GitHub allows in Job Summaries.
// ─────────────────────────────────────────────────────────────

// ── Theme ────────────────────────────────────────────────────

const BG = '#0d1117';
const CARD = '#161b22';
const BORDER = '#30363d';
const GRID = '#21262d';
const TEXT = '#e6edf3';
const MUTED = '#8b949e';
const GREEN = '#3fb950';
const BLUE = '#58a6ff';
const PURPLE = '#bc8cff';
const FONT =
  'ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,Liberation Mono,monospace';

// ── Helpers ──────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours().toString().padStart(2, '0');
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ── Monotone Cubic Hermite Interpolation (Fritsch-Carlson) ──

interface Point { x: number; y: number }

function monotoneCubicPath(pts: Point[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  if (pts.length === 2)
    return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`;

  const n = pts.length;
  const delta: number[] = [];
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1].x - pts[i].x);
    delta.push(h[i] !== 0 ? (pts[i + 1].y - pts[i].y) / h[i] : 0);
  }

  const m: number[] = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (delta[i - 1] + delta[i]) / 2;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const s = 3 / Math.sqrt(tau);
        m[i] = s * alpha * delta[i];
        m[i + 1] = s * beta * delta[i];
      }
    }
  }

  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1].x - pts[i].x) / 3;
    const cp1x = pts[i].x + dx;
    const cp1y = pts[i].y + m[i] * dx;
    const cp2x = pts[i + 1].x - dx;
    const cp2y = pts[i + 1].y - m[i + 1] * dx;
    d +=
      `C${cp1x.toFixed(1)},${cp1y.toFixed(1)},` +
      `${cp2x.toFixed(1)},${cp2y.toFixed(1)},` +
      `${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

// ── SVG Stat Cards ───────────────────────────────────────────

export interface StatCard {
  label: string;
  value: string;
  sub?: string;
  color: string;
}

export function renderStatCards(cards: StatCard[]): string {
  const count = cards.length;
  const cardW = 180;
  const gap = 12;
  const totalW = count * cardW + (count - 1) * gap;
  const h = 96;
  const padX = 16;

  const rects = cards
    .map((c, i) => {
      const x = i * (cardW + gap);
      return `
    <rect x="${x}" y="0" width="${cardW}" height="${h}" rx="6"
          fill="${CARD}" stroke="${BORDER}" stroke-width="1"/>
    <rect x="${x}" y="0" width="${cardW}" height="3" rx="6"
          fill="${c.color}"/>
    <text x="${x + padX}" y="32" fill="${MUTED}"
          font-size="11" font-family="${FONT}">${esc(c.label)}</text>
    <text x="${x + padX}" y="58" fill="${TEXT}"
          font-size="20" font-weight="bold" font-family="${FONT}">${esc(c.value)}</text>
    ${c.sub ? `<text x="${x + padX}" y="78" fill="${MUTED}" font-size="11" font-family="${FONT}">${esc(c.sub)}</text>` : ''}`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}"
  viewBox="0 0 ${totalW} ${h}" role="img">
  <rect width="${totalW}" height="${h}" fill="${BG}" rx="8"/>
  ${rects}
</svg>`;
}

// ── SVG Area Chart ───────────────────────────────────────────

export interface AreaChartOpts {
  title: string;
  values: number[];
  color: string;
  yLabel: string;
  startedAt: string;
  endedAt: string;
  currentValue?: string;
  steps?: { name: string; startedAt: string }[];
  formatY?: (v: number) => string;
}

export function renderAreaChart(opts: AreaChartOpts): string {
  const {
    title, values, color, yLabel, startedAt, endedAt,
    currentValue, steps, formatY = (v) => v.toFixed(0),
  } = opts;

  const W = 760; const H = 220;
  const pad = { top: 40, right: 20, bottom: 40, left: 52 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const yMax = Math.max(...values, 1) * 1.15;
  const yMin = 0;

  const sx = (i: number) =>
    pad.left + (i / Math.max(values.length - 1, 1)) * chartW;
  const sy = (v: number) =>
    pad.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const pts: Point[] = values.map((v, i) => ({ x: sx(i), y: sy(v) }));
  const curvePath = monotoneCubicPath(pts);
  const fillPath =
    curvePath +
    `L${pts[pts.length - 1].x.toFixed(1)},${(pad.top + chartH).toFixed(1)}` +
    `L${pts[0].x.toFixed(1)},${(pad.top + chartH).toFixed(1)}Z`;

  const gradId = `grad-${color.replace('#', '')}`;

  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const val = yMin + ((yMax - yMin) * i) / 4;
    const y = sy(val);
    gridLines.push(
      `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`,
    );
    yLabels.push(
      `<text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" fill="${MUTED}" font-size="10" font-family="${FONT}" text-anchor="end">${esc(formatY(val))}</text>`,
    );
  }

  const stepSeps: string[] = [];
  if (steps && steps.length > 0) {
    const tStart = new Date(startedAt).getTime();
    const tEnd = new Date(endedAt).getTime();
    const tDur = tEnd - tStart || 1;
    for (const step of steps) {
      const frac = (new Date(step.startedAt).getTime() - tStart) / tDur;
      if (frac <= 0.01 || frac >= 0.99) continue;
      const x = pad.left + frac * chartW;
      stepSeps.push(
        `<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + chartH}" stroke="${BORDER}" stroke-width="1" stroke-dasharray="4,3"/>`,
        `<text x="${(x + 4).toFixed(1)}" y="${pad.top - 4}" fill="${MUTED}" font-size="9" font-family="${FONT}" transform="rotate(-30,${(x + 4).toFixed(1)},${pad.top - 4})">${esc(truncate(step.name, 18))}</text>`,
      );
    }
  }

  const lastPt = pts[pts.length - 1];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
  viewBox="0 0 ${W} ${H}" role="img">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.05"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}" rx="8"/>
  <text x="${pad.left}" y="24" fill="${TEXT}" font-size="14" font-weight="bold" font-family="${FONT}">${esc(title)}</text>
  ${currentValue ? `<text x="${W - pad.right}" y="24" fill="${color}" font-size="13" font-family="${FONT}" text-anchor="end">${esc(currentValue)}</text>` : ''}
  ${gridLines.join('\n  ')}
  ${yLabels.join('\n  ')}
  ${stepSeps.join('\n  ')}
  <path d="${fillPath}" fill="url(#${gradId})"/>
  <path d="${curvePath}" fill="none" stroke="${color}" stroke-width="2"/>
  <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="4" fill="${color}" opacity="0.6"/>
  <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2" fill="${color}"/>
  <text x="${pad.left}" y="${H - 6}" fill="${MUTED}" font-size="10" font-family="${FONT}">${esc(fmtTime(startedAt))}</text>
  <text x="${W - pad.right}" y="${H - 6}" fill="${MUTED}" font-size="10" font-family="${FONT}" text-anchor="end">${esc(fmtTime(endedAt))}</text>
  <text x="${pad.left + chartW / 2}" y="${H - 6}" fill="${MUTED}" font-size="10" font-family="${FONT}" text-anchor="middle">${esc(yLabel)}</text>
</svg>`;
}

// ── SVG Gantt / Timeline ─────────────────────────────────────

export interface GanttStep {
  name: string;
  startedAt: string;
  completedAt: string;
  durationSec: number;
  color: string;
}

export interface GanttChartOpts {
  steps: GanttStep[];
  totalStartedAt: string;
  totalEndedAt: string;
}

const GANTT_COLORS = [GREEN, BLUE, PURPLE, '#f0883e', '#f778ba', '#79c0ff', '#d2a8ff', '#7ee787'];

export function pickGanttColor(index: number): string {
  return GANTT_COLORS[index % GANTT_COLORS.length];
}

export function renderGanttChart(opts: GanttChartOpts): string {
  const { steps, totalStartedAt, totalEndedAt } = opts;
  const rowH = 32;
  const nameColW = 180;
  const durColW = 64;
  const barPad = 12;
  const pad = { top: 40, right: 16, bottom: 16, left: 12 };
  const barAreaW = 760 - pad.left - nameColW - barPad - durColW - pad.right;
  const H = pad.top + steps.length * rowH + pad.bottom;
  const W = 760;

  const totalStart = new Date(totalStartedAt).getTime();
  const totalEnd = new Date(totalEndedAt).getTime();
  const totalDur = totalEnd - totalStart || 1;

  const rows = steps
    .map((step, i) => {
      const y = pad.top + i * rowH;
      const barX = pad.left + nameColW + barPad;
      const sStart = new Date(step.startedAt).getTime();
      const sEnd = new Date(step.completedAt).getTime();
      const fracStart = Math.max(0, (sStart - totalStart) / totalDur);
      const fracEnd = Math.min(1, (sEnd - totalStart) / totalDur);
      const barW = Math.max(4, (fracEnd - fracStart) * barAreaW);
      const barOffset = fracStart * barAreaW;

      return `
    <rect x="${barX}" y="${(y + 8).toFixed(0)}" width="${barAreaW}" height="16" rx="4" fill="${GRID}" opacity="0.5"/>
    <rect x="${(barX + barOffset).toFixed(1)}" y="${(y + 8).toFixed(0)}" width="${barW.toFixed(1)}" height="16" rx="4" fill="${step.color}" opacity="0.85"/>
    <text x="${pad.left + 4}" y="${(y + 21).toFixed(0)}" fill="${TEXT}" font-size="11" font-family="${FONT}">${esc(truncate(step.name, 24))}</text>
    <text x="${W - pad.right}" y="${(y + 21).toFixed(0)}" fill="${MUTED}" font-size="10" font-family="${FONT}" text-anchor="end">${esc(fmtDuration(step.durationSec))}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
  viewBox="0 0 ${W} ${H}" role="img">
  <rect width="${W}" height="${H}" fill="${BG}" rx="8"/>
  <text x="${pad.left + 4}" y="24" fill="${TEXT}" font-size="14" font-weight="bold" font-family="${FONT}">Execution Timeline</text>
  <text x="${pad.left + nameColW + barPad}" y="24" fill="${MUTED}" font-size="10" font-family="${FONT}">${esc(fmtTime(totalStartedAt))}</text>
  <text x="${pad.left + nameColW + barPad + barAreaW}" y="24" fill="${MUTED}" font-size="10" font-family="${FONT}" text-anchor="end">${esc(fmtTime(totalEndedAt))}</text>
  ${rows}
</svg>`;
}

// ── HTML Fallback (when rsvg-convert is unavailable) ─────────

export interface FallbackStatCard {
  label: string;
  value: string;
  sub?: string;
}

export function renderStatCardsFallback(cards: FallbackStatCard[]): string {
  const headers = cards.map((c) => `<th align="center">${esc(c.label)}</th>`).join('');
  const values = cards.map((c) => `<td align="center"><b>${esc(c.value)}</b></td>`).join('');
  const subs = cards.map((c) =>
    `<td align="center"><sub>${c.sub ? esc(c.sub) : ''}</sub></td>`,
  ).join('');
  return `<table>\n<tr>${headers}</tr>\n<tr>${values}</tr>\n<tr>${subs}</tr>\n</table>`;
}

const SPARK_CHARS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

export function sparkline(values: number[], width = 60): string {
  if (values.length === 0) return '';
  const buckets: number[] = [];
  if (values.length <= width) {
    buckets.push(...values);
  } else {
    const step = values.length / width;
    for (let i = 0; i < width; i++) {
      const lo = Math.floor(i * step);
      const hi = Math.min(Math.floor((i + 1) * step), values.length);
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += values[j];
      buckets.push(sum / (hi - lo));
    }
  }
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  const range = max - min || 1;
  return buckets
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join('');
}

const FB_BAR_WIDTH = 30;
const FB_FILLED = '\u2588';
const FB_EMPTY  = '\u2591';

export function renderGanttFallback(opts: { steps: { name: string; startedAt: string; completedAt: string; durationSec: number }[]; totalStartedAt: string; totalEndedAt: string }): string {
  const totalStart = new Date(opts.totalStartedAt).getTime();
  const totalEnd = new Date(opts.totalEndedAt).getTime();
  const totalDur = totalEnd - totalStart || 1;

  const rows = opts.steps.map((step) => {
    const fracStart = Math.max(0, (new Date(step.startedAt).getTime() - totalStart) / totalDur);
    const fracEnd = Math.min(1, (new Date(step.completedAt).getTime() - totalStart) / totalDur);
    const startCol = Math.round(fracStart * FB_BAR_WIDTH);
    const endCol = Math.max(startCol + 1, Math.round(fracEnd * FB_BAR_WIDTH));
    const bar = FB_EMPTY.repeat(startCol) + FB_FILLED.repeat(endCol - startCol) + FB_EMPTY.repeat(Math.max(0, FB_BAR_WIDTH - endCol));
    return `| ${esc(truncate(step.name, 28))} | <code>${bar}</code> | ${esc(fmtDuration(step.durationSec))} |`;
  });

  return ['| Step | Timeline | Duration |', '|:--|:--|--:|', ...rows].join('\n');
}
