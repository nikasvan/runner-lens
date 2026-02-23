// ─────────────────────────────────────────────────────────────
// RunnerLens — Mermaid Charts for GitHub Job Summary
//
// Generates Mermaid diagram definitions rendered natively by
// GitHub's markdown renderer. No external services or image
// uploads needed — charts are inline ```mermaid code blocks.
// ─────────────────────────────────────────────────────────────

import { fmtDuration } from './charts';

// ── Color palette (matches original dark theme) ─────────────

const COLORS = {
  cpu: '#58a6ff',
  mem: '#bc8cff',
  cyan: '#39d2c0',
  green: '#3fb950',
  bar: '#58a6ff',
  jobs: ['#58a6ff', '#bc8cff', '#39d2c0', '#3fb950'],
};

// ── Helpers ─────────────────────────────────────────────────

function downsample(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, values.length - 1);
    const frac = pos - lo;
    out.push(Math.round(values[lo] * (1 - frac) + values[hi] * frac));
  }
  return out;
}

function mermaidBlock(def: string): string {
  return '```mermaid\n' + def.trim() + '\n```';
}

/** Escape a string for safe use inside Mermaid labels. */
function escLabel(s: string): string {
  return s.replace(/"/g, "'").replace(/[[\]]/g, '').replace(/[#;]/g, '');
}

// ── Stat Cards (Markdown table) ─────────────────────────────

export interface StatCardItem {
  label: string;
  value: string;
  sub?: string;
  colorVar?: string;
}

/**
 * Stat cards as a markdown table. Mermaid has no stat-card
 * equivalent, so we use a clean markdown table that GitHub
 * renders with good formatting.
 */
export function statCards(items: StatCardItem[]): string {
  if (items.length === 0) return '';

  const header = '| ' + items.map(i => i.label).join(' | ') + ' |';
  const sep = '|' + items.map(() => ':---:').join('|') + '|';
  const values = '| ' + items.map(i => `**${i.value}**`).join(' | ') + ' |';
  const hasSubs = items.some(i => i.sub);
  const subs = hasSubs
    ? '| ' + items.map(i => i.sub ? `<sub>${i.sub}</sub>` : '').join(' | ') + ' |'
    : '';

  return [header, sep, values, ...(subs ? [subs] : [])].join('\n');
}

// ── Timeline Area Chart (CPU + Memory) ──────────────────────

export interface TimelineOpts {
  width?: number;
  height?: number;
  cpuAvg?: number;
  memAvg?: number;
  dataPoints?: number;
}

/**
 * Dual-series line chart for CPU and Memory usage over time.
 * Uses Mermaid xychart-beta with dark theme.
 */
export function timelineChart(
  cpuValues: number[],
  memValues: number[],
  opts: TimelineOpts = {},
): string {
  if (cpuValues.length < 2 && memValues.length < 2) return '';

  const n = opts.dataPoints ?? 40;
  const cpu = downsample(cpuValues, n);
  const mem = downsample(memValues, n);

  const cpuLabel = opts.cpuAvg !== undefined ? `CPU ${opts.cpuAvg.toFixed(0)}% avg` : 'CPU';
  const memLabel = opts.memAvg !== undefined ? `Memory ${opts.memAvg.toFixed(0)}% avg` : 'Memory';

  const lines: string[] = [];
  lines.push(`%%{init: {'theme': 'dark', 'themeVariables': {'xyChart': {'plotColorPalette': '${COLORS.cpu}, ${COLORS.mem}'}}}}%%`);
  lines.push('xychart-beta');
  lines.push(`    title "${escLabel(cpuLabel)} · ${escLabel(memLabel)}"`);
  lines.push(`    x-axis "Samples" [${cpu.map((_, i) => i).join(', ')}]`);
  lines.push('    y-axis "Usage %" 0 --> 100');
  if (cpu.length >= 2) lines.push(`    line [${cpu.join(', ')}]`);
  if (mem.length >= 2) lines.push(`    line [${mem.join(', ')}]`);

  return mermaidBlock(lines.join('\n'));
}

// ── Per-Step Horizontal Bar Chart ───────────────────────────

export interface StepBarData {
  name: string;
  value: number;
}

export interface StepBarOpts {
  width?: number;
  barHeight?: number;
  formatValue?: (v: number) => string;
}

/**
 * Bar chart for per-step metrics.
 * Uses Mermaid xychart-beta with dark theme.
 */
export function stepBarChart(steps: StepBarData[], opts: StepBarOpts = {}): string {
  if (steps.length === 0) return '';

  const fmt = opts.formatValue ?? ((v: number) => String(v));

  const labels = steps.map(s => {
    const name = s.name.length > 18 ? s.name.slice(0, 17) + '\u2026' : s.name;
    return `"${escLabel(name)} (${escLabel(fmt(s.value))})"`;
  });

  const lines: string[] = [];
  lines.push(`%%{init: {'theme': 'dark', 'themeVariables': {'xyChart': {'plotColorPalette': '${COLORS.bar}'}}}}%%`);
  lines.push('xychart-beta');
  lines.push('    title "Step Durations"');
  lines.push(`    x-axis [${labels.join(', ')}]`);
  lines.push('    y-axis "Duration (s)"');
  lines.push(`    bar [${steps.map(s => Math.round(s.value)).join(', ')}]`);

  return mermaidBlock(lines.join('\n'));
}

// ── Waterfall / Gantt Chart ─────────────────────────────────

export interface WaterfallStep {
  label: string;
  startSec: number;
  durationSec: number;
  group?: string;
}

export interface WaterfallOpts {
  width?: number;
  barHeight?: number;
  title?: string;
  formatDuration?: (s: number) => string;
}

/**
 * Waterfall/Gantt chart showing step execution times, grouped by job.
 * Uses Mermaid gantt with dark theme.
 */
export function waterfallChart(steps: WaterfallStep[], opts: WaterfallOpts = {}): string {
  if (steps.length === 0) return '';

  const fmt = opts.formatDuration ?? fmtDuration;
  const title = opts.title ?? 'Execution Timeline';

  // Group steps by group name preserving order
  const groupOrder: string[] = [];
  const groupMap = new Map<string, WaterfallStep[]>();
  for (const s of steps) {
    const g = s.group ?? 'default';
    if (!groupMap.has(g)) {
      groupOrder.push(g);
      groupMap.set(g, []);
    }
    groupMap.get(g)!.push(s);
  }

  const lines: string[] = [];
  lines.push('%%{init: {"theme": "dark"}}%%');
  lines.push('gantt');
  lines.push(`    title ${escLabel(title)}`);
  lines.push('    dateFormat X');
  lines.push('    axisFormat %H:%M:%S');

  for (const group of groupOrder) {
    const groupSteps = groupMap.get(group)!;
    lines.push(`    section ${escLabel(group)}`);
    for (const s of groupSteps) {
      let stepName = s.label;
      // Strip "job · " prefix — job is shown in section header
      if (s.group && stepName.startsWith(s.group + ' \u00b7 ')) {
        stepName = stepName.slice(s.group.length + 3);
      }
      stepName = stepName.length > 20 ? stepName.slice(0, 19) + '\u2026' : stepName;
      const start = Math.round(s.startSec);
      const end = Math.max(start + 1, Math.round(s.startSec + s.durationSec));
      lines.push(`    ${escLabel(stepName)} (${fmt(s.durationSec)}) :${start}, ${end}`);
    }
  }

  return mermaidBlock(lines.join('\n'));
}

// ── Workflow Timeline Chart (single series) ─────────────────

export interface TimelineSegment {
  label: string;
  values: number[];
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowTimelineOpts {
  width?: number;
  height?: number;
  color: string;          // CSS var name, e.g. 'cpu-stroke'
  fillColor: string;      // CSS var name, e.g. 'cpu-fill'
  yMax: number;
  yFormat?: (v: number) => string;
  title?: string;
  dataPoints?: number;
}

/**
 * Single-series line chart with job segment labels.
 * Uses Mermaid xychart-beta with dark theme.
 */
export function workflowTimelineChart(
  segments: TimelineSegment[],
  opts: WorkflowTimelineOpts,
): string {
  const allValues = segments.flatMap(s => s.values);
  if (allValues.length < 2) return '';

  const n = opts.dataPoints ?? 40;
  const ds = downsample(allValues, n);
  const yMax = Math.ceil(opts.yMax);
  const yFormat = opts.yFormat ?? ((v: number) => v.toFixed(0));
  const title = opts.title ?? 'Timeline';

  const color = opts.color === 'cpu-stroke' ? COLORS.cpu : COLORS.mem;
  const lastVal = ds[ds.length - 1];

  const lines: string[] = [];
  lines.push(`%%{init: {'theme': 'dark', 'themeVariables': {'xyChart': {'plotColorPalette': '${color}'}}}}%%`);
  lines.push('xychart-beta');
  lines.push(`    title "${escLabel(title)} (${escLabel(yFormat(lastVal))})"`);
  lines.push(`    x-axis "Samples" [${ds.map((_, i) => i).join(', ')}]`);
  lines.push(`    y-axis "${escLabel(yFormat(0))} - ${escLabel(yFormat(yMax))}" 0 --> ${yMax}`);
  lines.push(`    line [${ds.join(', ')}]`);

  return mermaidBlock(lines.join('\n'));
}
