// ─────────────────────────────────────────────────────────────
// RunnerLens — HTML Charts for GitHub Job Summary
//
// GitHub Job Summary strips <style>, <rect>, <path>, <line>,
// and blocks SVG data-URIs. These functions produce pure HTML
// tables with inline styles that render reliably.
// ─────────────────────────────────────────────────────────────

import { fmtDuration } from './charts';

const SPARKLINE_BLOCKS = '▁▂▃▄▅▆▇█';

// ── Helpers ─────────────────────────────────────────────────

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

// ── Sparkline ───────────────────────────────────────────────

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

// ── Stat Cards ──────────────────────────────────────────────

export interface StatCard {
  label: string;
  value: string;
  sub?: string;
  color?: string;  // hex color
}

/** Horizontal row of stat cards as an HTML table. */
export function htmlStatCards(cards: StatCard[]): string {
  if (cards.length === 0) return '';
  const cells = cards.map(c => {
    return [
      `<td align="center">`,
      `<strong>${esc(c.value)}</strong><br>`,
      `<sub>${esc(c.label)}</sub>`,
      c.sub ? `<br><sub>${esc(c.sub)}</sub>` : '',
      `</td>`,
    ].join('');
  });
  return `<table><tr>${cells.join('')}</tr></table>`;
}

// ── Bar Chart ───────────────────────────────────────────────

export interface BarItem {
  label: string;
  value: number;
  formatValue?: string;
}

/** Horizontal bar chart as Markdown table with Unicode blocks. */
export function htmlBarChart(
  items: BarItem[],
  opts: { maxWidth?: number; formatValue?: (v: number) => string } = {},
): string {
  if (items.length === 0) return '';
  const maxVal = Math.max(...items.map(i => i.value), 1);
  const maxW = opts.maxWidth ?? 20;
  const fmt = opts.formatValue ?? ((v: number) => String(v));

  const rows = items.map(item => {
    const barLen = Math.max(1, Math.round((item.value / maxVal) * maxW));
    const bar = '█'.repeat(barLen);
    const name = item.label.length > 28 ? item.label.slice(0, 27) + '…' : item.label;
    return `| ${esc(name)} | \`${bar}\` | ${esc(fmt(item.value))} |`;
  });

  return [
    '| Step | | Duration |',
    '|:---|:---|---:|',
    ...rows,
  ].join('\n');
}

// ── Timeline Sparklines ─────────────────────────────────────

interface SparklineRow {
  label: string;
  values: number[];
  avg: string;
}

/** CPU + Memory sparklines in a code block. */
export function htmlTimeline(rows: SparklineRow[], width = 50): string {
  if (rows.length === 0) return '';
  const maxLabel = Math.max(...rows.map(r => r.label.length));
  const lines = rows.map(r => {
    const pad = r.label.padEnd(maxLabel);
    return `${pad}  ${sparkline(r.values, width)}  ${r.avg}`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

// ── Waterfall / Gantt ───────────────────────────────────────

export interface WaterfallRow {
  job: string;
  step: string;
  startSec: number;
  durationSec: number;
}

/** Execution timeline as Markdown table with positioned bars. */
export function htmlWaterfall(
  rows: WaterfallRow[],
  opts: { totalWidth?: number } = {},
): string {
  if (rows.length === 0) return '';
  const totalEnd = Math.max(...rows.map(r => r.startSec + r.durationSec), 1);
  const W = opts.totalWidth ?? 30;

  const tableRows = rows.map(r => {
    const startPos = Math.round((r.startSec / totalEnd) * W);
    const barLen = Math.max(1, Math.round((r.durationSec / totalEnd) * W));
    const bar = ' '.repeat(startPos) + '█'.repeat(barLen);
    const step = r.step.length > 18 ? r.step.slice(0, 17) + '…' : r.step;
    return `| ${esc(r.job)} | ${esc(step)} | \`${bar}\` | ${fmtDuration(r.durationSec)} |`;
  });

  return [
    '| Job | Step | Timeline | Duration |',
    '|:---|:---|:---|---:|',
    ...tableRows,
  ].join('\n');
}
