// ─────────────────────────────────────────────────────────────
// RunnerLens — Job Summary Builder
//
// Renders dark-themed SVG charts → converts to PNG via
// rsvg-convert → embeds as data:image/png;base64 <img> tags.
// Falls back to HTML/markdown when rsvg-convert is unavailable.
// ─────────────────────────────────────────────────────────────

import * as core from '@actions/core';
import type { AggregatedReport } from './types';
import { REPORT_VERSION } from './constants';
import {
  renderStatCards,
  renderAreaChart,
  renderGanttChart,
  pickGanttColor,
  svgToPngDataUri,
  imgTag,
  fmtDuration,
  renderStatCardsFallback,
  sparkline,
  renderGanttFallback,
  type GanttStep,
  type FallbackStatCard,
} from './svg-charts';

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// ── SVG → PNG path (preferred) ───────────────────────────────

async function buildSvgSummary(report: AggregatedReport): Promise<string | null> {
  const parts: string[] = [];

  // Stat cards
  const cardsSvg = renderStatCards([
    { label: 'Runner', value: report.system.runner_os, sub: `${report.system.cpu_count} CPU \u00b7 ${fmtMem(report.system.total_memory_mb)}`, color: '#3fb950' },
    { label: 'Duration', value: fmtDuration(report.duration_seconds), sub: `${report.sample_count} samples`, color: '#58a6ff' },
    { label: 'Avg CPU', value: `${report.cpu.avg.toFixed(1)}%`, sub: `peak ${report.cpu.max.toFixed(1)}%`, color: '#f0883e' },
    { label: 'Memory', value: fmtMem(report.memory.avg), sub: `of ${fmtMem(report.memory.total_mb)}`, color: '#bc8cff' },
  ]);

  const cardsUri = await svgToPngDataUri(cardsSvg);
  if (!cardsUri) return null; // rsvg-convert not available

  parts.push(imgTag(cardsUri, 'RunnerLens Stats'));

  // Area charts
  const timeline = report.timeline;
  if (timeline && timeline.cpu_pct.length >= 2) {
    const stepSeps = report.steps?.map((s) => ({
      name: s.name,
      startedAt: s.started_at,
    }));

    const cpuSvg = renderAreaChart({
      title: 'CPU Usage',
      values: timeline.cpu_pct,
      color: '#58a6ff',
      yLabel: 'CPU %',
      startedAt: report.started_at,
      endedAt: report.ended_at,
      currentValue: `${report.cpu.latest.toFixed(1)}%`,
      steps: stepSeps,
      formatY: (v) => `${v.toFixed(0)}%`,
    });

    const cpuUri = await svgToPngDataUri(cpuSvg);
    if (cpuUri) parts.push(imgTag(cpuUri, 'CPU Usage Chart'));

    const memSvg = renderAreaChart({
      title: 'Memory Usage',
      values: timeline.mem_mb,
      color: '#bc8cff',
      yLabel: 'Memory',
      startedAt: report.started_at,
      endedAt: report.ended_at,
      currentValue: fmtMem(report.memory.latest),
      steps: stepSeps,
      formatY: (v) => fmtMem(v),
    });

    const memUri = await svgToPngDataUri(memSvg);
    if (memUri) parts.push(imgTag(memUri, 'Memory Usage Chart'));
  }

  // Gantt timeline
  if (report.steps && report.steps.length > 0) {
    const ganttSteps: GanttStep[] = report.steps.map((s, i) => ({
      name: s.name,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      durationSec: s.duration_seconds,
      color: pickGanttColor(i),
    }));

    const ganttSvg = renderGanttChart({
      steps: ganttSteps,
      totalStartedAt: report.started_at,
      totalEndedAt: report.ended_at,
    });

    const ganttUri = await svgToPngDataUri(ganttSvg);
    if (ganttUri) parts.push(imgTag(ganttUri, 'Execution Timeline'));
  }

  return parts.join('\n\n');
}

// ── HTML/markdown fallback ───────────────────────────────────

function buildFallbackSummary(report: AggregatedReport): string {
  const parts: string[] = [];

  const cards: FallbackStatCard[] = [
    { label: '\ud83d\udda5\ufe0f Runner', value: `${report.system.runner_os} (${report.system.runner_arch})`, sub: `${report.system.cpu_count} vCPU \u00b7 ${fmtMem(report.system.total_memory_mb)}` },
    { label: '\u23f1\ufe0f Duration', value: fmtDuration(report.duration_seconds), sub: `${report.sample_count} samples` },
    { label: '\u26a1 CPU', value: `avg ${report.cpu.avg.toFixed(1)}%`, sub: `p95 ${report.cpu.p95.toFixed(1)}% \u00b7 peak ${report.cpu.max.toFixed(1)}%` },
    { label: '\ud83d\udcbe Memory', value: `avg ${fmtMem(report.memory.avg)}`, sub: `peak ${fmtMem(report.memory.max)} / ${fmtMem(report.memory.total_mb)}` },
  ];
  parts.push(renderStatCardsFallback(cards));

  const timeline = report.timeline;
  if (timeline && timeline.cpu_pct.length >= 2) {
    parts.push([
      `**CPU** \u00a0 \`${sparkline(timeline.cpu_pct)}\` \u00a0 avg ${report.cpu.avg.toFixed(1)}% \u00b7 p95 ${report.cpu.p95.toFixed(1)}% \u00b7 peak ${report.cpu.max.toFixed(1)}%`,
      '',
      `**Memory** \u00a0 \`${sparkline(timeline.mem_mb)}\` \u00a0 avg ${fmtMem(report.memory.avg)} \u00b7 peak ${fmtMem(report.memory.max)}`,
    ].join('\n'));
  }

  if (report.steps && report.steps.length > 0) {
    parts.push(
      '<details>\n<summary><b>Execution Timeline</b></summary>\n\n' +
      renderGanttFallback({
        steps: report.steps.map((s) => ({ name: s.name, startedAt: s.started_at, completedAt: s.completed_at, durationSec: s.duration_seconds })),
        totalStartedAt: report.started_at,
        totalEndedAt: report.ended_at,
      }) +
      '\n</details>',
    );
  }

  return parts.join('\n\n');
}

// ── Public API ───────────────────────────────────────────────

export async function buildJobSummary(report: AggregatedReport): Promise<string> {
  const parts: string[] = [];

  // Try SVG → PNG path first
  const svgContent = await buildSvgSummary(report);
  if (svgContent) {
    core.info('RunnerLens: rendered PNG charts via rsvg-convert');
    parts.push(svgContent);
  } else {
    core.info('RunnerLens: rsvg-convert not found, using text fallback');
    parts.push(buildFallbackSummary(report));
  }

  parts.push(
    `<sub>Generated by <a href="https://github.com/runnerlens/runner-lens">RunnerLens</a> v${REPORT_VERSION}</sub>`,
  );

  return parts.join('\n\n');
}
