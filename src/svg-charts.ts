// ─────────────────────────────────────────────────────────────
// RunnerLens — SVG Charts v2 for GitHub Job Summary
// ─────────────────────────────────────────────────────────────

import { fmtDuration } from './charts';

// ── Internal helpers ────────────────────────────────────────

/** Encode an SVG string as a base64 data URI. */
function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Wrap an SVG string in an <img> tag with a base64 data URI. */
export function svgImg(svg: string, alt: string, width?: number, height?: number): string {
  const uri = svgToDataUri(svg);
  const dims = [
    width ? `width="${width}"` : '',
    height ? `height="${height}"` : '',
  ].filter(Boolean).join(' ');
  return `<img src="${uri}" alt="${alt}"${dims ? ` ${dims}` : ''} />`;
}

/** CSS custom properties — dark by default, light via media query (matches GitHub). */
function themeStyles(): string {
  return `<style>
      :root {
        --bg: #0d1117; --bg-card: #161b22; --fg: #e6edf3;
        --grid: #30363d; --grid-subtle: #21262d; --muted: #8b949e;
        --cpu-stroke: #58a6ff; --cpu-fill: rgba(88,166,255,0.25);
        --mem-stroke: #bc8cff; --mem-fill: rgba(188,140,255,0.25);
        --bar-fill: #58a6ff; --bar-bg: #21262d;
        --accent-blue: #58a6ff; --accent-purple: #bc8cff;
        --accent-cyan: #39d2c0; --accent-green: #3fb950;
        --group-band: rgba(255,255,255,0.02);
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #ffffff; --bg-card: #f6f8fa; --fg: #24292f;
          --grid: #d0d7de; --grid-subtle: #eaeef2; --muted: #656d76;
          --cpu-stroke: #0969da; --cpu-fill: rgba(9,105,218,0.25);
          --mem-stroke: #8250df; --mem-fill: rgba(130,80,223,0.25);
          --bar-fill: #0969da; --bar-bg: #eaeef2;
          --accent-blue: #0969da; --accent-purple: #8250df;
          --accent-cyan: #0598bc; --accent-green: #1a7f37;
          --group-band: rgba(0,0,0,0.03);
        }
      }
      text { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
    </style>`;
}

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

/** Build an SVG polyline path d-attribute from data points. */
function polylinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`;
  }
  return d;
}

/** Build a smooth cubic bezier path from data points. */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const x0 = points[i - 1].x, y0 = points[i - 1].y;
    const x1 = points[i].x, y1 = points[i].y;
    const cx = (x0 + x1) / 2;
    d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** Escape a string for safe use inside SVG <text> elements. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format an ISO timestamp to a short time string (HH:MM). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours().toString().padStart(2, '0');
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ── Timeline Area Chart ─────────────────────────────────────

export interface TimelineOpts {
  width?: number;
  height?: number;
  cpuAvg?: number;
  memAvg?: number;
  dataPoints?: number;
}

/**
 * Dual-series area chart for CPU and Memory usage over time.
 * Returns raw SVG string (use svgImg to embed).
 */
export function timelineChart(
  cpuValues: number[],
  memValues: number[],
  opts: TimelineOpts = {},
): string {
  if (cpuValues.length < 2 && memValues.length < 2) return '';

  const W        = opts.width ?? 600;
  const H        = opts.height ?? 200;
  const padTop   = 32;
  const padRight = 12;
  const padBot   = 30;
  const padLeft  = 42;
  const plotW    = W - padLeft - padRight;
  const plotH    = H - padTop - padBot;
  const nPoints  = opts.dataPoints ?? 80;

  function toPoints(values: number[]): Array<{ x: number; y: number }> {
    const rs = resample(values, nPoints);
    return rs.map((v, i) => ({
      x: padLeft + (i / Math.max(rs.length - 1, 1)) * plotW,
      y: padTop + plotH - (Math.min(Math.max(v, 0), 100) / 100) * plotH,
    }));
  }

  function areaPath(points: Array<{ x: number; y: number }>): string {
    if (points.length === 0) return '';
    const baseline = padTop + plotH;
    return polylinePath(points) +
      ` L${points[points.length - 1].x.toFixed(1)},${baseline.toFixed(1)}` +
      ` L${points[0].x.toFixed(1)},${baseline.toFixed(1)} Z`;
  }

  const cpuPts = cpuValues.length >= 2 ? toPoints(cpuValues) : [];
  const memPts = memValues.length >= 2 ? toPoints(memValues) : [];

  // Grid lines at 0%, 25%, 50%, 75%, 100%
  const gridLines: string[] = [];
  for (const pct of [0, 25, 50, 75, 100]) {
    const y = padTop + plotH - (pct / 100) * plotH;
    gridLines.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${W - padRight}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`,
    );
    gridLines.push(
      `<text x="${padLeft - 6}" y="${(y + 4).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="end">${pct}%</text>`,
    );
  }

  // X-axis labels (start / middle / end)
  const totalSamples = Math.max(cpuValues.length, memValues.length);
  const xLabels = [
    `<text x="${padLeft}" y="${H - 6}" fill="var(--muted)" font-size="10" text-anchor="start">0</text>`,
    `<text x="${padLeft + plotW / 2}" y="${H - 6}" fill="var(--muted)" font-size="10" text-anchor="middle">${Math.round(totalSamples / 2)}</text>`,
    `<text x="${padLeft + plotW}" y="${H - 6}" fill="var(--muted)" font-size="10" text-anchor="end">${totalSamples}</text>`,
  ];

  // Legend
  const cpuAvgLabel = opts.cpuAvg !== undefined ? ` ${opts.cpuAvg.toFixed(0)}% avg` : '';
  const memAvgLabel = opts.memAvg !== undefined ? ` ${opts.memAvg.toFixed(0)}% avg` : '';
  const legend = [
    `<rect x="${padLeft}" y="8" width="10" height="10" rx="2" fill="var(--cpu-stroke)"/>`,
    `<text x="${padLeft + 14}" y="17" fill="var(--fg)" font-size="11" font-weight="600">CPU${escapeXml(cpuAvgLabel)}</text>`,
    `<rect x="${padLeft + 120}" y="8" width="10" height="10" rx="2" fill="var(--mem-stroke)"/>`,
    `<text x="${padLeft + 134}" y="17" fill="var(--fg)" font-size="11" font-weight="600">Memory${escapeXml(memAvgLabel)}</text>`,
  ];

  // Series paths
  const memArea = memPts.length > 0
    ? `<path d="${areaPath(memPts)}" fill="var(--mem-fill)"/><path d="${polylinePath(memPts)}" fill="none" stroke="var(--mem-stroke)" stroke-width="2"/>`
    : '';
  const cpuArea = cpuPts.length > 0
    ? `<path d="${areaPath(cpuPts)}" fill="var(--cpu-fill)"/><path d="${polylinePath(cpuPts)}" fill="none" stroke="var(--cpu-stroke)" stroke-width="2"/>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs>${themeStyles()}</defs>`,
    `<rect width="${W}" height="${H}" rx="6" fill="var(--bg)"/>`,
    ...gridLines,
    ...xLabels,
    memArea,
    cpuArea,
    ...legend,
    `</svg>`,
  ].join('');
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
 * Horizontal bar chart for per-step metrics. Returns raw SVG string.
 */
export function stepBarChart(steps: StepBarData[], opts: StepBarOpts = {}): string {
  if (steps.length === 0) return '';

  const W         = opts.width ?? 600;
  const barH      = opts.barHeight ?? 24;
  const gap       = 6;
  const padTop    = 8;
  const padBot    = 8;
  const padLeft   = 160;
  const padRight  = 60;
  const barAreaW  = W - padLeft - padRight;
  const H         = padTop + steps.length * (barH + gap) - gap + padBot;

  const maxVal = Math.max(...steps.map((s) => s.value), 1);
  const fmt = opts.formatValue ?? ((v: number) => String(v));

  const bars: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const y = padTop + i * (barH + gap);
    const s = steps[i];
    const barW = Math.max((s.value / maxVal) * barAreaW, 2);
    const name = s.name.length > 22 ? s.name.slice(0, 21) + '\u2026' : s.name;

    // Step name label
    bars.push(
      `<text x="${padLeft - 8}" y="${(y + barH / 2 + 4).toFixed(1)}" fill="var(--fg)" font-size="12" text-anchor="end">${escapeXml(name)}</text>`,
    );
    // Background bar
    bars.push(
      `<rect x="${padLeft}" y="${y}" width="${barAreaW}" height="${barH}" rx="4" fill="var(--bar-bg)"/>`,
    );
    // Value bar
    bars.push(
      `<rect x="${padLeft}" y="${y}" width="${barW.toFixed(1)}" height="${barH}" rx="4" fill="var(--bar-fill)"/>`,
    );
    // Value label
    bars.push(
      `<text x="${(padLeft + barW + 6).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}" fill="var(--muted)" font-size="11">${escapeXml(fmt(s.value))}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs>${themeStyles()}</defs>`,
    `<rect width="${W}" height="${H}" rx="6" fill="var(--bg)"/>`,
    ...bars,
    `</svg>`,
  ].join('');
}

// ── Stat Cards ──────────────────────────────────────────────

export interface StatCardItem {
  label: string;
  value: string;
  sub?: string;
  colorVar?: string;  // CSS var name without --, e.g. 'accent-blue'
}

export interface StatCardOpts {
  width?: number;
}

/**
 * Row of stat cards with colored accent bar. Returns raw SVG string.
 */
export function statCards(items: StatCardItem[], opts: StatCardOpts = {}): string {
  if (items.length === 0) return '';

  const W      = opts.width ?? 600;
  const padO   = 6;
  const gap    = 8;
  const cols   = items.length;
  const cardW  = (W - padO * 2 - gap * (cols - 1)) / cols;
  const cardH  = 64;
  const H      = cardH + padO * 2;

  const els: string[] = [];
  for (let i = 0; i < cols; i++) {
    const item = items[i];
    const x = padO + i * (cardW + gap);
    const colorRef = item.colorVar ? `var(--${item.colorVar})` : 'var(--accent-blue)';

    // Card background
    els.push(`<rect x="${x}" y="${padO}" width="${cardW}" height="${cardH}" rx="6" fill="var(--bg-card)" stroke="var(--grid)" stroke-width="0.5"/>`);
    // Accent bar
    els.push(`<rect x="${x}" y="${padO}" width="${cardW}" height="3" rx="6" fill="${colorRef}" opacity="0.7"/>`);
    // Value (scale font down for long text)
    const valFontSize = item.value.length > 14 ? 11 : item.value.length > 10 ? 13 : 16;
    els.push(`<text x="${x + cardW / 2}" y="${padO + 30}" fill="${colorRef}" font-size="${valFontSize}" font-weight="700" text-anchor="middle">${escapeXml(item.value)}</text>`);
    // Label
    els.push(`<text x="${x + cardW / 2}" y="${padO + 45}" fill="var(--muted)" font-size="9" text-anchor="middle">${escapeXml(item.label)}</text>`);
    // Sub-label
    if (item.sub) {
      els.push(`<text x="${x + cardW / 2}" y="${padO + 57}" fill="var(--muted)" font-size="8" text-anchor="middle" opacity="0.6">${escapeXml(item.sub)}</text>`);
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs>${themeStyles()}</defs>`,
    ...els,
    `</svg>`,
  ].join('');
}

// ── Waterfall Chart (Execution Timeline) ─────────────────────

export interface WaterfallStep {
  label: string;
  startSec: number;
  durationSec: number;
  group?: string;       // job name — determines bar color
}

export interface WaterfallOpts {
  width?: number;
  barHeight?: number;
  title?: string;
  formatDuration?: (s: number) => string;
}

/**
 * Waterfall/Gantt chart showing step execution times, grouped by job.
 * Each bar is positioned by start time with width proportional to duration.
 * Jobs are visually grouped with background bands, colored accent bars,
 * and a job name label in the left margin.
 * Returns raw SVG string.
 */
export function waterfallChart(steps: WaterfallStep[], opts: WaterfallOpts = {}): string {
  if (steps.length === 0) return '';

  const W      = opts.width ?? 600;
  const barH   = opts.barHeight ?? 22;
  const padL   = 8;
  const padR   = 8;
  const padTop = opts.title ? 28 : 8;
  const gap    = 2;
  const jobLabelW = 56;   // left margin for job name
  const stepLabelW = 110; // step name area
  const durW   = 55;
  const barArea = W - jobLabelW - stepLabelW - durW - padL - padR;
  const barLeft = padL + jobLabelW + stepLabelW;
  const fmt    = opts.formatDuration ?? fmtDuration;

  const totalEnd = Math.max(...steps.map(s => s.startSec + s.durationSec), 1);

  // Assign colors per group (job name)
  const groupColors = ['accent-blue', 'accent-purple', 'accent-cyan', 'accent-green'];
  const groupMap = new Map<string, string>();
  let colorIdx = 0;
  for (const s of steps) {
    const g = s.group ?? '';
    if (g && !groupMap.has(g)) {
      groupMap.set(g, groupColors[colorIdx % groupColors.length]);
      colorIdx++;
    }
  }

  // Identify group spans (start index, count)
  const groups: Array<{ name: string; start: number; count: number; colorVar: string }> = [];
  let prevGroup: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    const g = steps[i].group ?? '';
    if (g !== prevGroup) {
      groups.push({ name: g, start: i, count: 1, colorVar: groupMap.get(g) ?? 'accent-blue' });
      prevGroup = g;
    } else {
      groups[groups.length - 1].count++;
    }
  }

  // Compute group separators spacing
  const groupGap = 6; // extra space between groups
  // Compute y position accounting for group gaps
  function stepY(idx: number): number {
    let y = padTop;
    let gapsAbove = 0;
    for (const g of groups) {
      if (idx < g.start) break;
      if (g.start > 0 && idx >= g.start) gapsAbove++;
    }
    // Subtract 1 because first group doesn't get a gap
    gapsAbove = Math.max(0, gapsAbove - 1);
    y += idx * (barH + gap) + gapsAbove * groupGap;
    return y;
  }

  const lastStep = steps.length - 1;
  const H = stepY(lastStep) + barH + 8;

  const els: string[] = [];

  // Title
  if (opts.title) {
    els.push(`<text x="${padL + 4}" y="18" fill="var(--muted)" font-size="10">${escapeXml(opts.title)}</text>`);
  }

  // Draw group background bands, accent bars, and job labels
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const yStart = stepY(g.start) - 1;
    const yEnd = stepY(g.start + g.count - 1) + barH + 1;
    const bandH = yEnd - yStart;

    // Alternating subtle background band
    if (gi % 2 === 1) {
      els.push(
        `<rect x="0" y="${yStart.toFixed(1)}" width="${W}" height="${bandH.toFixed(1)}" fill="var(--group-band)"/>`,
      );
    }

    // Colored accent bar on the left edge
    els.push(
      `<rect x="${padL}" y="${yStart.toFixed(1)}" width="3" height="${bandH.toFixed(1)}" rx="1.5" fill="var(--${g.colorVar})" opacity="0.6"/>`,
    );

    // Job name label (vertically centered in group)
    const labelY = yStart + bandH / 2;
    const jobName = g.name.length > 8 ? g.name.slice(0, 7) + '\u2026' : g.name;
    els.push(
      `<text x="${padL + 8}" y="${labelY.toFixed(1)}" fill="var(--${g.colorVar})" font-size="9" font-weight="600" dominant-baseline="middle">${escapeXml(jobName)}</text>`,
    );

    // Separator line between groups
    if (gi > 0) {
      const sepY = yStart - groupGap / 2;
      els.push(
        `<line x1="${padL}" y1="${sepY.toFixed(1)}" x2="${W - padR}" y2="${sepY.toFixed(1)}" stroke="var(--grid)" stroke-width="0.5" opacity="0.4"/>`,
      );
    }
  }

  // Draw step rows
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const y = stepY(i);
    const bx = barLeft + (step.startSec / totalEnd) * barArea;
    const bw = Math.max(2, (step.durationSec / totalEnd) * barArea);
    const colorVar = step.group ? (groupMap.get(step.group) ?? 'accent-blue') : 'accent-blue';

    // Step name (strip "job · " prefix if present — job is shown in left margin)
    let stepName = step.label;
    if (step.group && stepName.startsWith(step.group + ' · ')) {
      stepName = stepName.slice(step.group.length + 3);
    }
    stepName = stepName.length > 16 ? stepName.slice(0, 15) + '\u2026' : stepName;

    // Step name
    els.push(
      `<text x="${padL + jobLabelW}" y="${(y + barH / 2 + 1).toFixed(1)}" fill="var(--fg)" font-size="9.5" dominant-baseline="middle">${escapeXml(stepName)}</text>`,
    );
    // Background track
    els.push(
      `<rect x="${barLeft}" y="${(y + 3).toFixed(1)}" width="${barArea}" height="${barH - 6}" rx="2" fill="var(--grid-subtle)" opacity="0.5"/>`,
    );
    // Duration bar
    els.push(
      `<rect x="${bx.toFixed(1)}" y="${(y + 3).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH - 6}" rx="2" fill="var(--${colorVar})" opacity="0.85"/>`,
    );
    // Duration text
    els.push(
      `<text x="${W - padR - 4}" y="${(y + barH / 2 + 1).toFixed(1)}" fill="var(--muted)" font-size="9.5" text-anchor="end" dominant-baseline="middle">${escapeXml(fmt(step.durationSec))}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs>${themeStyles()}</defs>`,
    `<rect width="${W}" height="${H}" rx="6" fill="var(--bg-card)"/>`,
    ...els,
    `</svg>`,
  ].join('');
}

// ── Workflow Timeline Chart ──────────────────────────────────

export interface TimelineSegment {
  label: string;       // job name
  values: number[];    // raw values for this segment
  startedAt?: string;  // ISO timestamp for X-axis labels
  endedAt?: string;    // ISO timestamp for X-axis labels
}

export interface WorkflowTimelineOpts {
  width?: number;
  height?: number;
  color: string;          // CSS var name, e.g. 'cpu-stroke'
  fillColor: string;      // CSS var name, e.g. 'cpu-fill'
  yMax: number;           // maximum Y value (100 for CPU%, totalMB for memory)
  yFormat?: (v: number) => string;  // Y-axis label formatter
  title?: string;         // e.g. "CPU Usage" or "Memory Usage"
  dataPoints?: number;
}

/**
 * Single-series area chart with smooth curves, gradient fill,
 * and job segment dividers. Returns raw SVG string.
 */
export function workflowTimelineChart(
  segments: TimelineSegment[],
  opts: WorkflowTimelineOpts,
): string {
  const rawValues = segments.flatMap(s => s.values);
  if (rawValues.length < 2) return '';

  const hasTimestamps = segments.every(s => s.startedAt && s.endedAt);
  const W        = opts.width ?? 600;
  const padTop   = 28;
  const padRight = 12;
  const padBot   = hasTimestamps ? 36 : 24;
  const padLeft  = 52;
  const H        = opts.height ?? (hasTimestamps ? 172 : 160);
  const plotW    = W - padLeft - padRight;
  const plotH    = H - padTop - padBot;
  const nPoints  = opts.dataPoints ?? 80;
  const yMax     = opts.yMax > 0 ? opts.yMax : 1;
  const yFormat  = opts.yFormat ?? ((v: number) => v.toFixed(0));
  const gradId   = `grad_${opts.color.replace(/[^a-z]/g, '')}`;

  // When timestamps are available, resample each segment proportionally
  // to its real duration so the X-axis is time-proportional.
  let allValues: number[];
  let segBoundaries: number[]; // cumulative sample index where each segment starts
  if (hasTimestamps) {
    const durations = segments.map(s => {
      const start = new Date(s.startedAt!).getTime();
      const end = new Date(s.endedAt!).getTime();
      return Math.max(end - start, 1);
    });
    const totalDur = durations.reduce((a, b) => a + b, 0);
    allValues = [];
    segBoundaries = [0];
    for (let i = 0; i < segments.length; i++) {
      const segPoints = Math.max(2, Math.round((durations[i] / totalDur) * nPoints));
      const resampled = resample(segments[i].values, segPoints);
      allValues.push(...resampled);
      segBoundaries.push(allValues.length);
    }
  } else {
    allValues = rawValues;
    segBoundaries = [0];
    let cum = 0;
    for (const s of segments) { cum += s.values.length; segBoundaries.push(cum); }
  }

  // Resample combined values to final point count
  const rs = resample(allValues, nPoints);

  // Map segment boundaries to resampled index space
  const totalLen = allValues.length;
  const rsSegBoundaries = segBoundaries.map(b =>
    Math.round((b / Math.max(totalLen, 1)) * (rs.length - 1)),
  );

  // Map resampled values to SVG points
  const points = rs.map((v, i) => ({
    x: padLeft + (i / Math.max(rs.length - 1, 1)) * plotW,
    y: padTop + plotH - (Math.min(Math.max(v, 0), yMax) / yMax) * plotH,
  }));

  // Smooth bezier line path
  const linePath = smoothPath(points);

  // Area path (smooth line → baseline → close)
  const baseline = padTop + plotH;
  const areaD = linePath +
    ` L${points[points.length - 1].x.toFixed(1)},${baseline.toFixed(1)}` +
    ` L${points[0].x.toFixed(1)},${baseline.toFixed(1)} Z`;

  // Gradient definition
  const gradDef =
    `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="var(--${opts.color})" stop-opacity="0.3"/>` +
    `<stop offset="100%" stop-color="var(--${opts.color})" stop-opacity="0.02"/>` +
    `</linearGradient>`;

  // Grid lines — 3 subtle lines
  const gridLines: string[] = [];
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const frac = i / gridSteps;
    const val = frac * yMax;
    const y = padTop + plotH - frac * plotH;
    gridLines.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${W - padRight}" y2="${y.toFixed(1)}" stroke="var(--grid-subtle)" stroke-width="0.5"/>`,
    );
    gridLines.push(
      `<text x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" fill="var(--muted)" font-size="9" text-anchor="end">${escapeXml(yFormat(val))}</text>`,
    );
  }

  // Job segment dividers, job labels, and time axis
  const dividers: string[] = [];
  const maxIdx = Math.max(rs.length - 1, 1);
  for (let si = 0; si < segments.length; si++) {
    const segStartIdx = rsSegBoundaries[si];
    const segEndIdx = rsSegBoundaries[si + 1];

    // Dashed divider line at segment boundary
    if (si > 0) {
      const xPos = padLeft + (segStartIdx / maxIdx) * plotW;
      dividers.push(
        `<line x1="${xPos.toFixed(1)}" y1="${padTop}" x2="${xPos.toFixed(1)}" y2="${(padTop + plotH).toFixed(1)}" stroke="var(--muted)" stroke-width="0.5" stroke-dasharray="4,3" opacity="0.6"/>`,
      );
    }

    // Job name label centered within segment
    const segMidIdx = (segStartIdx + segEndIdx) / 2;
    const xLabel = padLeft + (segMidIdx / maxIdx) * plotW;
    const name = segments[si].label.length > 16 ? segments[si].label.slice(0, 15) + '\u2026' : segments[si].label;
    dividers.push(
      `<text x="${xLabel.toFixed(1)}" y="${H - (hasTimestamps ? 14 : 5)}" fill="var(--muted)" font-size="9" text-anchor="middle">${escapeXml(name)}</text>`,
    );
  }

  // Time axis labels (from segment timestamps)
  if (hasTimestamps) {
    // Start time of first segment
    dividers.push(
      `<text x="${padLeft}" y="${H - 4}" fill="var(--muted)" font-size="8" text-anchor="start">${escapeXml(fmtTime(segments[0].startedAt!))}</text>`,
    );
    // End time of last segment
    dividers.push(
      `<text x="${(W - padRight)}" y="${H - 4}" fill="var(--muted)" font-size="8" text-anchor="end">${escapeXml(fmtTime(segments[segments.length - 1].endedAt!))}</text>`,
    );
    // Divider timestamps (start of each segment after the first)
    for (let si = 1; si < segments.length; si++) {
      if (segments[si].startedAt) {
        const xPos = padLeft + (rsSegBoundaries[si] / maxIdx) * plotW;
        dividers.push(
          `<text x="${xPos.toFixed(1)}" y="${H - 4}" fill="var(--muted)" font-size="8" text-anchor="middle">${escapeXml(fmtTime(segments[si].startedAt!))}</text>`,
        );
      }
    }
  }

  // Endpoint dot with glow
  const lastPt = points[points.length - 1];
  const endDot = [
    `<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="4" fill="var(--${opts.color})" opacity="0.3"/>`,
    `<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.5" fill="var(--${opts.color})"/>`,
  ];

  // Title + current value
  const lastVal = rs[rs.length - 1];
  const titleEl = opts.title
    ? `<text x="${padLeft}" y="16" fill="var(--muted)" font-size="10">${escapeXml(opts.title)}</text>`
    : '';
  const valEl = opts.title
    ? `<text x="${W - padRight}" y="16" fill="var(--${opts.color})" font-size="10" text-anchor="end">${escapeXml(yFormat(lastVal))}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<defs>${themeStyles()}${gradDef}</defs>`,
    `<rect width="${W}" height="${H}" rx="6" fill="var(--bg-card)"/>`,
    ...gridLines,
    ...dividers,
    `<path d="${areaD}" fill="url(#${gradId})"/>`,
    `<path d="${linePath}" fill="none" stroke="var(--${opts.color})" stroke-width="1.5" stroke-linecap="round"/>`,
    ...endDot,
    titleEl,
    valEl,
    `</svg>`,
  ].join('');
}
