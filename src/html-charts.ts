// ─────────────────────────────────────────────────────────────
// RunnerLens — HTML Charts for GitHub Job Summary
//
// GitHub Job Summary strips <style>, <svg>, <rect>, <path>,
// and blocks data URIs. The `style` attribute is also stripped.
//
// These functions produce pure HTML tables using `bgcolor` for
// colored accents, progress bars, and gantt bars. Falls back
// gracefully to plain text if bgcolor is unsupported.
// ─────────────────────────────────────────────────────────────

import { fmtDuration } from './charts';

const SPARKLINE_BLOCKS = '▁▂▃▄▅▆▇█';

// ── Theme colors (matching SVG palette) ──────────────────────

const C = {
  card:   '#161b22',
  border: '#30363d',
  muted:  '#8b949e',
  blue:   '#58a6ff',
  purple: '#bc8cff',
  cyan:   '#39d2c0',
  green:  '#3fb950',
  bar:    '#58a6ff',
  barBg:  '#21262d',
  jobs:   ['#58a6ff', '#bc8cff', '#39d2c0', '#3fb950'],
  // Subtle area fills: ~10% accent color mixed with card bg
  fillBlue:   '#1d2938',
  fillPurple: '#272638',
};

// ── Helpers ──────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function downsample(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, values.length - 1);
    const frac = pos - lo;
    out.push(values[lo] * (1 - frac) + values[hi] * frac);
  }
  return out;
}

// ── Sparkline ────────────────────────────────────────────────

/** Unicode sparkline from numeric array. */
export function sparkline(values: number[], width = 50): string {
  if (values.length === 0) return '';
  const ds = downsample(values, width);
  const lo = Math.min(...ds);
  const hi = Math.max(...ds);
  const range = hi - lo || 1;
  return ds
    .map(v => SPARKLINE_BLOCKS[Math.min(Math.round(((v - lo) / range) * 7), 7)])
    .join('');
}

// ── Stat Cards ───────────────────────────────────────────────

export interface StatCard {
  label: string;
  value: string;
  sub?: string;
  color?: string;  // hex color for top accent strip
}

// SVG reference: each card is 141×64, 4 cards, 8px gaps
const CARD_W = 141;

/**
 * Stat cards as dark card panels with colored top accent bars.
 *
 * Matches SVG reference: 141px wide × 64px tall cards with
 * 0.5px border (#30363d), 3px colored accent at top,
 * centered value/label/sub text. 8px gaps between cards.
 */
export function htmlStatCards(cards: StatCard[]): string {
  if (cards.length === 0) return '';

  const cells: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const color = c.color || C.muted;
    if (i > 0) cells.push('<td width="8"></td>');

    // Border: outer table with bgcolor=border + cellspacing=1
    // creates a 1px border frame around the card.
    cells.push([
      `<td width="${CARD_W}" valign="top">`,
      `<table width="${CARD_W}" cellspacing="1" cellpadding="0" bgcolor="${C.border}">`,
      `<tr><td bgcolor="${C.card}">`,
      `<table width="100%" cellspacing="0" cellpadding="0">`,
      `<tr><td bgcolor="${color}" height="3"></td></tr>`,
      `<tr><td height="10"></td></tr>`,
      `<tr><td align="center"><strong>${esc(c.value)}</strong></td></tr>`,
      `<tr><td height="2"></td></tr>`,
      `<tr><td align="center"><sub>${esc(c.label)}</sub></td></tr>`,
      c.sub ? `<tr><td height="1"></td></tr><tr><td align="center"><sub>${esc(c.sub)}</sub></td></tr>` : '',
      `<tr><td height="8"></td></tr>`,
      `</table>`,
      `</td></tr>`,
      `</table>`,
      `</td>`,
    ].join(''));
  }

  return `<table cellspacing="0" cellpadding="0">\n<tr>\n${cells.join('\n')}\n</tr>\n</table>`;
}

// ── Bar Chart ────────────────────────────────────────────────

export interface BarItem {
  label: string;
  value: number;
  formatValue?: string;
}

/**
 * Horizontal bar chart with colored progress bars using bgcolor.
 *
 * Each row: step name | colored bar (bgcolor) | duration
 */
export function htmlBarChart(
  items: BarItem[],
  opts: { maxWidth?: number; formatValue?: (v: number) => string } = {},
): string {
  if (items.length === 0) return '';
  const maxVal = Math.max(...items.map(i => i.value), 1);
  const fmt = opts.formatValue ?? ((v: number) => String(v));

  const rows: string[] = [];
  rows.push('<table width="100%" cellspacing="0" cellpadding="2">');

  for (const item of items) {
    const pct = Math.max(1, Math.round((item.value / maxVal) * 100));
    const name = item.label.length > 28 ? item.label.slice(0, 27) + '\u2026' : item.label;

    rows.push('<tr>');
    rows.push(`<td width="140" align="right"><sub>${esc(name)}</sub></td>`);
    rows.push('<td>');
    rows.push(`<table width="100%" cellspacing="0" cellpadding="0"><tr>`);
    rows.push(`<td bgcolor="${C.bar}" width="${pct}%" height="14">&nbsp;</td>`);
    rows.push(`<td bgcolor="${C.barBg}" height="14">&nbsp;</td>`);
    rows.push(`</tr></table>`);
    rows.push('</td>');
    rows.push(`<td width="65" align="right"><sub>${esc(fmt(item.value))}</sub></td>`);
    rows.push('</tr>');
  }

  rows.push('</table>');
  return rows.join('\n');
}

// ── Timeline Line Chart ─────────────────────────────────────

interface SparklineRow {
  label: string;
  values: number[];
  avg: string;
}

const CHART_H = 108; // chart area height in px (matches SVG)
const LINE_H = 2;    // line thickness in px
const NUM_COLS = 50;  // data points (dense = smooth line)

/**
 * CPU + Memory timeline as line charts with subtle area fill.
 *
 * Matches the SVG reference: a thin colored line at each data
 * point with a subtle fill area below, inside a dark card.
 * Each metric gets its own card with title + value header.
 */
export function htmlTimeline(rows: SparklineRow[], width = NUM_COLS): string {
  if (rows.length === 0) return '';

  const parts: string[] = [];

  for (const r of rows) {
    const isMem = r.label.toLowerCase().includes('mem');
    const color = isMem ? C.purple : C.blue;
    const fill = isMem ? C.fillPurple : C.fillBlue;
    const ds = downsample(r.values, width);
    const peak = Math.max(...ds, 1);

    // Card container
    parts.push(`<table width="100%" cellspacing="0" cellpadding="0" bgcolor="${C.card}">`);
    parts.push(`<tr><td colspan="4" height="10"></td></tr>`);

    // Title row: "CPU Usage" left, value right
    parts.push('<tr>');
    parts.push(`<td width="12"></td>`);
    parts.push(`<td><sub><strong>${esc(r.label)} Usage</strong></sub></td>`);
    parts.push(`<td align="right"><sub>${esc(r.avg)}</sub></td>`);
    parts.push(`<td width="12"></td>`);
    parts.push('</tr>');
    parts.push(`<tr><td colspan="4" height="10"></td></tr>`);

    // Line chart — flush columns, each: space above | line | fill below
    parts.push('<tr>');
    parts.push(`<td width="12"></td>`);
    parts.push('<td colspan="2">');
    parts.push(`<table width="100%" cellspacing="0" cellpadding="0"><tr valign="bottom">`);

    for (const v of ds) {
      const pct = v / peak;
      const above = Math.round((1 - pct) * (CHART_H - LINE_H));
      const below = (CHART_H - LINE_H) - above;

      parts.push('<td>');
      parts.push(`<table width="100%" cellspacing="0" cellpadding="0">`);
      if (above > 0) {
        parts.push(`<tr><td height="${above}"></td></tr>`);
      }
      parts.push(`<tr><td bgcolor="${color}" height="${LINE_H}"></td></tr>`);
      if (below > 0) {
        parts.push(`<tr><td bgcolor="${fill}" height="${below}"></td></tr>`);
      }
      parts.push(`</table>`);
      parts.push('</td>');
    }

    parts.push('</tr></table>');
    parts.push('</td>');
    parts.push(`<td width="12"></td>`);
    parts.push('</tr>');
    parts.push(`<tr><td colspan="4" height="12"></td></tr>`);
    parts.push('</table>');
    parts.push('');
  }

  return parts.join('\n');
}

// ── Waterfall / Gantt ────────────────────────────────────────

export interface WaterfallRow {
  job: string;
  step: string;
  startSec: number;
  durationSec: number;
}

/**
 * Execution timeline with colored gantt bars grouped by job.
 *
 * Matches SVG reference: dark card background (#161b22), colored
 * accent strips per job group, step names, gantt bars on gray tracks,
 * and duration labels. Job groups separated by thin divider lines.
 */
export function htmlWaterfall(
  rows: WaterfallRow[],
  _opts: { totalWidth?: number } = {},
): string {
  if (rows.length === 0) return '';
  const totalEnd = Math.max(...rows.map(r => r.startSec + r.durationSec), 1);

  // Assign colors per job
  const jobColors = new Map<string, string>();
  let colorIdx = 0;
  for (const r of rows) {
    if (!jobColors.has(r.job)) {
      jobColors.set(r.job, C.jobs[colorIdx % C.jobs.length]);
      colorIdx++;
    }
  }

  const parts: string[] = [];
  parts.push(`<table width="100%" cellspacing="0" cellpadding="3" bgcolor="${C.card}">`);

  let prevJob = '';
  for (const r of rows) {
    const color = jobColors.get(r.job) || C.bar;
    const step = r.step.length > 18 ? r.step.slice(0, 17) + '\u2026' : r.step;
    const startPct = Math.round((r.startSec / totalEnd) * 100);
    const durPct = Math.max(1, Math.round((r.durationSec / totalEnd) * 100));

    const showJob = r.job !== prevJob;

    if (showJob && prevJob !== '') {
      parts.push(`<tr><td colspan="5" bgcolor="${C.border}" height="1"></td></tr>`);
    }
    prevJob = r.job;

    const jobLabel = showJob ? `<strong>${esc(r.job)}</strong>` : '';

    parts.push('<tr>');
    parts.push(`<td bgcolor="${color}" width="3">&nbsp;</td>`);
    parts.push(`<td width="55"><sub>${jobLabel}</sub></td>`);
    parts.push(`<td width="100"><sub>${esc(step)}</sub></td>`);
    parts.push('<td>');
    parts.push(`<table width="100%" cellspacing="0" cellpadding="0"><tr>`);
    if (startPct > 0) {
      parts.push(`<td bgcolor="${C.barBg}" width="${startPct}%" height="14">&nbsp;</td>`);
    }
    parts.push(`<td bgcolor="${color}" width="${durPct}%" height="14">&nbsp;</td>`);
    parts.push(`<td bgcolor="${C.barBg}" height="14">&nbsp;</td>`);
    parts.push(`</tr></table>`);
    parts.push('</td>');
    parts.push(`<td width="55" align="right"><sub>${fmtDuration(r.durationSec)}</sub></td>`);
    parts.push('</tr>');
  }

  parts.push('</table>');
  return parts.join('\n');
}
