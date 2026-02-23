// ─────────────────────────────────────────────────────────────
// RunnerLens — HTML Summary Charts (inline styles)
//
// Renders charts as pure HTML with inline `style` attributes
// for GitHub Job Summary. No external services, no images,
// no SVG — just HTML that GitHub's sanitizer allows through.
// ─────────────────────────────────────────────────────────────

import { fmtDuration } from './charts';

// ── Colors ──────────────────────────────────────────────────

const C = {
  bg: '#0d1117',
  card: '#161b22',
  border: '#30363d',
  fg: '#e6edf3',
  muted: '#8b949e',
  cyan: '#39d2c0',
  green: '#3fb950',
  blue: '#58a6ff',
  purple: '#bc8cff',
  barBg: '#21262d',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

// ── Stat Cards ──────────────────────────────────────────────

export interface StatCardData {
  label: string;
  value: string;
  sub: string;
  color: string;
}

export function htmlStatCards(cards: StatCardData[]): string {
  const cellWidth = Math.floor(100 / cards.length);
  const cells = cards.map(c => `<td style="width:${cellWidth}%;background:${C.card};border:1px solid ${C.border};border-top:3px solid ${c.color};border-radius:6px;padding:8px 6px;text-align:center;vertical-align:top;">
<strong style="color:${c.color};font-size:14px;">${esc(c.value)}</strong><br>
<span style="color:${C.muted};font-size:11px;">${esc(c.label)}</span><br>
<span style="color:${C.muted};font-size:10px;opacity:0.7;">${esc(c.sub)}</span>
</td>`).join('\n');

  return `<table style="width:100%;border-collapse:separate;border-spacing:6px;font-family:${FONT};">
<tr>
${cells}
</tr>
</table>`;
}

// ── Step Bar Chart ──────────────────────────────────────────

export interface StepBarData {
  name: string;
  durationSec: number;
}

export function htmlStepBars(steps: StepBarData[]): string {
  const maxDur = Math.max(...steps.map(s => s.durationSec), 1);

  const rows = steps.map(s => {
    const pct = Math.max(1, Math.round((s.durationSec / maxDur) * 100));
    const dur = fmtDuration(s.durationSec);
    const name = s.name.length > 30 ? s.name.slice(0, 29) + '…' : s.name;
    return `<tr>
<td style="white-space:nowrap;text-align:right;padding:3px 8px 3px 0;color:${C.fg};font-size:12px;">${esc(name)}</td>
<td style="width:70%;padding:3px 0;">
<div style="background:${C.blue};height:16px;width:${pct}%;border-radius:3px;min-width:2px;"></div>
</td>
<td style="padding:3px 0 3px 8px;color:${C.muted};font-size:11px;white-space:nowrap;">${dur}</td>
</tr>`;
  }).join('\n');

  return `<table style="width:100%;border-collapse:collapse;font-family:${FONT};background:${C.bg};border-radius:6px;padding:8px;">
${rows}
</table>`;
}

// ── CPU/Memory Gauge Bars ───────────────────────────────────

export function htmlGaugeBars(opts: {
  cpuAvg: number;
  cpuPeak: number;
  memAvgPct: number;
  memPeakPct: number;
  memPeakGb: string;
}): string {
  const cpuW = Math.max(1, Math.round(opts.cpuAvg));
  const memW = Math.max(1, Math.round(opts.memAvgPct));

  return `<table style="width:100%;border-collapse:collapse;font-family:${FONT};background:${C.bg};border-radius:6px;padding:4px 0;">
<tr>
<td style="white-space:nowrap;text-align:right;padding:4px 8px;color:${C.fg};font-size:12px;">CPU</td>
<td style="width:70%;padding:4px 0;">
<div style="background:${C.barBg};border-radius:3px;height:18px;position:relative;">
<div style="background:${C.blue};height:18px;width:${cpuW}%;border-radius:3px;"></div>
</div>
</td>
<td style="padding:4px 8px;color:${C.muted};font-size:11px;white-space:nowrap;">${opts.cpuAvg.toFixed(0)}% avg · peak ${opts.cpuPeak.toFixed(0)}%</td>
</tr>
<tr>
<td style="white-space:nowrap;text-align:right;padding:4px 8px;color:${C.fg};font-size:12px;">Mem</td>
<td style="width:70%;padding:4px 0;">
<div style="background:${C.barBg};border-radius:3px;height:18px;position:relative;">
<div style="background:${C.purple};height:18px;width:${memW}%;border-radius:3px;"></div>
</div>
</td>
<td style="padding:4px 8px;color:${C.muted};font-size:11px;white-space:nowrap;">${opts.memAvgPct.toFixed(0)}% avg · peak ${opts.memPeakPct.toFixed(0)}% · ${opts.memPeakGb}</td>
</tr>
</table>`;
}

// ── Waterfall (Execution Timeline) ──────────────────────────

export interface WaterfallStep {
  job: string;
  step: string;
  startSec: number;
  durationSec: number;
}

const GROUP_COLORS = [C.blue, C.purple, C.cyan, C.green];

export function htmlWaterfall(steps: WaterfallStep[]): string {
  const totalSec = Math.max(...steps.map(s => s.startSec + s.durationSec), 1);

  const jobColors = new Map<string, string>();
  let colorIdx = 0;
  for (const s of steps) {
    if (!jobColors.has(s.job)) {
      jobColors.set(s.job, GROUP_COLORS[colorIdx % GROUP_COLORS.length]);
      colorIdx++;
    }
  }

  const rows = steps.map(s => {
    const leftPct = Math.round((s.startSec / totalSec) * 100);
    const widthPct = Math.max(1, Math.round((s.durationSec / totalSec) * 100));
    const color = jobColors.get(s.job)!;
    const step = s.step.length > 20 ? s.step.slice(0, 19) + '…' : s.step;
    const job = s.job.length > 10 ? s.job.slice(0, 9) + '…' : s.job;
    const dur = fmtDuration(s.durationSec);

    return `<tr>
<td style="white-space:nowrap;text-align:right;padding:2px 6px;color:${C.muted};font-size:10px;">${esc(job)}</td>
<td style="white-space:nowrap;text-align:right;padding:2px 4px;color:${C.fg};font-size:11px;">${esc(step)}</td>
<td style="width:60%;padding:2px 0;">
<div style="background:${C.barBg};height:14px;border-radius:2px;position:relative;">
<div style="position:absolute;left:${leftPct}%;width:${widthPct}%;height:14px;background:${color};border-radius:2px;min-width:2px;"></div>
</div>
</td>
<td style="padding:2px 6px;color:${C.muted};font-size:10px;white-space:nowrap;">${dur}</td>
</tr>`;
  }).join('\n');

  return `<table style="width:100%;border-collapse:collapse;font-family:${FONT};background:${C.bg};border-radius:6px;padding:4px 0;">
${rows}
</table>`;
}

// ── Helpers ─────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
