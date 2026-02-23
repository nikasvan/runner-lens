// ─────────────────────────────────────────────────────────────
// RunnerLens — SVG Charts Test Suite
// ─────────────────────────────────────────────────────────────

import { svgImg, timelineChart, stepBarChart, workflowTimelineChart, waterfallChart, statCards } from '../src/svg-charts';

// ── svgImg ──────────────────────────────────────────────────

describe('svgImg', () => {
  const trivialSvg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

  it('returns inline SVG (not data URI)', () => {
    const result = svgImg(trivialSvg, 'test');
    expect(result).toMatch(/^<svg /);
    expect(result).not.toContain('data:image/svg+xml');
    expect(result).not.toContain('<img');
  });

  it('resolves CSS variables to static colors', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--cpu-stroke)"/></svg>';
    const result = svgImg(svg, 'test');
    expect(result).toContain('fill="#58a6ff"');
    expect(result).not.toContain('var(--');
  });

  it('strips <style> blocks', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><style>text{}</style></defs></svg>';
    const result = svgImg(svg, 'test');
    expect(result).not.toContain('<style>');
  });

  it('injects font-family into text elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10">Hi</text></svg>';
    const result = svgImg(svg, 'test');
    expect(result).toContain('font-family=');
    expect(result).toContain('monospace');
  });
});

// ── timelineChart ───────────────────────────────────────────

describe('timelineChart', () => {
  it('returns empty string for fewer than 2 values', () => {
    expect(timelineChart([], [])).toBe('');
    expect(timelineChart([42], [42])).toBe('');
  });

  it('returns a valid SVG for normal input', () => {
    const cpu = [10, 20, 30, 40, 50];
    const mem = [60, 50, 40, 30, 20];
    const svg = timelineChart(cpu, mem);
    expect(svg).toMatch(/^<svg [\s\S]+<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains CPU and Memory legend text', () => {
    const svg = timelineChart([10, 20], [30, 40], { cpuAvg: 15, memAvg: 35 });
    expect(svg).toContain('CPU');
    expect(svg).toContain('Memory');
    expect(svg).toContain('15% avg');
    expect(svg).toContain('35% avg');
  });

  it('contains Y-axis labels', () => {
    const svg = timelineChart([10, 90], [20, 80]);
    expect(svg).toContain('0%');
    expect(svg).toContain('50%');
    expect(svg).toContain('100%');
  });

  it('contains area paths (fill and stroke)', () => {
    const svg = timelineChart([10, 20, 30], [40, 50, 60]);
    expect(svg).toContain('var(--cpu-fill)');
    expect(svg).toContain('var(--cpu-stroke)');
    expect(svg).toContain('var(--mem-fill)');
    expect(svg).toContain('var(--mem-stroke)');
  });

  it('handles 1000+ data points without issue', () => {
    const big = Array.from({ length: 2000 }, (_, i) => (i % 100));
    expect(() => timelineChart(big, big)).not.toThrow();
    const svg = timelineChart(big, big);
    expect(svg).toContain('<svg');
  });

  it('uses CSS variable references for theming', () => {
    const svg = timelineChart([10, 20], [30, 40]);
    expect(svg).toContain('var(--');
  });

  it('works when only one series has data', () => {
    const svg = timelineChart([10, 20, 30], []);
    expect(svg).toMatch(/^<svg [\s\S]+<\/svg>$/);
    expect(svg).toContain('var(--cpu-stroke)');
  });
});

// ── stepBarChart ────────────────────────────────────────────

describe('stepBarChart', () => {
  it('returns empty string for empty steps', () => {
    expect(stepBarChart([])).toBe('');
  });

  it('returns a valid SVG for normal input', () => {
    const steps = [
      { name: 'Checkout', value: 5 },
      { name: 'Build', value: 120 },
      { name: 'Test', value: 60 },
    ];
    const svg = stepBarChart(steps);
    expect(svg).toMatch(/^<svg [\s\S]+<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains a rect for each step (value bar + background bar)', () => {
    const steps = [
      { name: 'A', value: 10 },
      { name: 'B', value: 20 },
    ];
    const svg = stepBarChart(steps);
    // 2 steps × 2 rects each (bg + fill) + 1 bg rect = 5 total
    const rectCount = (svg.match(/<rect /g) ?? []).length;
    expect(rectCount).toBe(5); // 1 background + 2×2 bars
  });

  it('includes step names in the SVG', () => {
    const svg = stepBarChart([{ name: 'Build', value: 10 }]);
    expect(svg).toContain('Build');
  });

  it('truncates long step names', () => {
    const svg = stepBarChart([{ name: 'A very long step name that exceeds the limit', value: 10 }]);
    expect(svg).toContain('\u2026'); // ellipsis
  });

  it('XML-escapes special characters in step names', () => {
    const svg = stepBarChart([{ name: 'Build "app" <v2> & deploy', value: 10 }]);
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&gt;');
    expect(svg).toContain('&quot;');
    expect(svg).not.toContain('& deploy');
  });

  it('uses custom value formatter', () => {
    const svg = stepBarChart(
      [{ name: 'Step', value: 125 }],
      { formatValue: (v) => `${Math.floor(v / 60)}m ${v % 60}s` },
    );
    expect(svg).toContain('2m 5s');
  });

  it('uses CSS variable references for theming', () => {
    const svg = stepBarChart([{ name: 'X', value: 1 }]);
    expect(svg).toContain('var(--');
  });
});

// ── workflowTimelineChart ───────────────────────────────────

describe('workflowTimelineChart', () => {
  const baseOpts = {
    color: 'cpu-stroke',
    fillColor: 'cpu-fill',
    yMax: 100,
    yFormat: (v: number) => `${v.toFixed(0)}%`,
    title: 'CPU Usage',
  };

  it('returns empty string when total values < 2', () => {
    expect(workflowTimelineChart([], baseOpts)).toBe('');
    expect(workflowTimelineChart([{ label: 'job1', values: [42] }], baseOpts)).toBe('');
  });

  it('returns a valid SVG for normal input', () => {
    const segments = [
      { label: 'build', values: [10, 20, 30, 40, 50] },
      { label: 'test', values: [60, 70, 80, 90, 95] },
    ];
    const svg = workflowTimelineChart(segments, baseOpts);
    expect(svg).toMatch(/^<svg [\s\S]+<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains job dividers between segments', () => {
    const segments = [
      { label: 'build', values: [10, 20, 30] },
      { label: 'test', values: [40, 50, 60] },
    ];
    const svg = workflowTimelineChart(segments, baseOpts);
    // Dashed divider line
    expect(svg).toContain('stroke-dasharray="4,3"');
  });

  it('does not have divider for single segment', () => {
    const segments = [{ label: 'build', values: [10, 20, 30] }];
    const svg = workflowTimelineChart(segments, baseOpts);
    expect(svg).not.toContain('stroke-dasharray="4,3"');
  });

  it('contains job name labels', () => {
    const segments = [
      { label: 'build', values: [10, 20, 30] },
      { label: 'test', values: [40, 50, 60] },
    ];
    const svg = workflowTimelineChart(segments, baseOpts);
    expect(svg).toContain('build');
    expect(svg).toContain('test');
  });

  it('contains Y-axis labels formatted via yFormat', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 50, 90] }],
      baseOpts,
    );
    expect(svg).toContain('0%');
    expect(svg).toContain('50%');
    expect(svg).toContain('100%');
  });

  it('renders Y-axis with GB format for memory', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [1024, 2048, 3072] }],
      {
        color: 'mem-stroke',
        fillColor: 'mem-fill',
        yMax: 7168,
        yFormat: (v) => `${(v / 1024).toFixed(1)} GB`,
        title: 'Memory Usage',
      },
    );
    expect(svg).toContain('0.0 GB');
    expect(svg).toContain('7.0 GB');
  });

  it('contains gradient fill and stroke paths', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    // Gradient fill with linearGradient referencing the stroke color
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('var(--cpu-stroke)');
    expect(svg).toContain('url(#grad_');
  });

  it('uses smooth bezier curves (C command)', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30, 40, 50] }],
      baseOpts,
    );
    // Smooth path uses C (cubic bezier) instead of just L (line)
    expect(svg).toMatch(/ C[\d.]+,[\d.]+ /);
  });

  it('renders endpoint dot with glow', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    // Two circles: glow (r=4 opacity 0.3) and solid (r=2.5)
    expect(svg).toMatch(/<circle[^/]*r="4"/);
    expect(svg).toMatch(/<circle[^/]*r="2\.5"/);
  });

  it('uses card background', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(svg).toContain('var(--bg-card)');
  });

  it('includes title text', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(svg).toContain('CPU Usage');
  });

  it('uses CSS variable references for theming', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(svg).toContain('var(--');
  });

  it('handles many data points without issue', () => {
    const big = Array.from({ length: 2000 }, (_, i) => i % 100);
    expect(() => workflowTimelineChart([{ label: 'job', values: big }], baseOpts)).not.toThrow();
  });

  it('truncates long job names', () => {
    const svg = workflowTimelineChart(
      [{ label: 'a-very-long-job-name-exceeding-limit', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(svg).toContain('\u2026');
  });

  it('shows current value next to title', () => {
    const svg = workflowTimelineChart(
      [{ label: 'job', values: [10, 50, 90] }],
      baseOpts,
    );
    // Last value formatted via yFormat should appear
    expect(svg).toContain('90%');
  });
});

// ── waterfallChart ──────────────────────────────────────────

describe('waterfallChart', () => {
  it('returns empty string for empty steps', () => {
    expect(waterfallChart([])).toBe('');
  });

  it('returns a valid SVG for normal input', () => {
    const svg = waterfallChart([
      { label: 'build · Checkout', startSec: 0, durationSec: 8, group: 'build' },
      { label: 'build · Install', startSec: 8, durationSec: 45, group: 'build' },
      { label: 'test · Run tests', startSec: 53, durationSec: 120, group: 'test' },
    ]);
    expect(svg).toMatch(/^<svg [\s\S]+<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains step labels', () => {
    const svg = waterfallChart([
      { label: 'build · Checkout', startSec: 0, durationSec: 8, group: 'build' },
      { label: 'test · Run tests', startSec: 8, durationSec: 120, group: 'test' },
    ]);
    expect(svg).toContain('build');
    expect(svg).toContain('Checkout');
    expect(svg).toContain('test');
    expect(svg).toContain('Run tests');
  });

  it('contains duration labels', () => {
    const svg = waterfallChart([
      { label: 'Step A', startSec: 0, durationSec: 125, group: 'job' },
    ]);
    expect(svg).toContain('2m 5s');
  });

  it('uses custom duration formatter', () => {
    const svg = waterfallChart(
      [{ label: 'Step A', startSec: 0, durationSec: 90, group: 'job' }],
      { formatDuration: (s) => `${s} sec` },
    );
    expect(svg).toContain('90 sec');
  });

  it('assigns different colors per group', () => {
    const svg = waterfallChart([
      { label: 'A', startSec: 0, durationSec: 10, group: 'build' },
      { label: 'B', startSec: 10, durationSec: 20, group: 'test' },
    ]);
    expect(svg).toContain('var(--accent-blue)');
    expect(svg).toContain('var(--accent-purple)');
  });

  it('has rect elements for track and bar per step', () => {
    const svg = waterfallChart([
      { label: 'A', startSec: 0, durationSec: 10, group: 'job1' },
      { label: 'B', startSec: 10, durationSec: 20, group: 'job1' },
    ]);
    // 1 bg + 1 accent bar + 2 track + 2 fill = 6 rects
    const rectCount = (svg.match(/<rect /g) ?? []).length;
    expect(rectCount).toBe(6);
  });

  it('uses card background', () => {
    const svg = waterfallChart([{ label: 'X', startSec: 0, durationSec: 1 }]);
    expect(svg).toContain('var(--bg-card)');
  });

  it('includes title when provided', () => {
    const svg = waterfallChart(
      [{ label: 'X', startSec: 0, durationSec: 1 }],
      { title: 'Execution Timeline' },
    );
    expect(svg).toContain('Execution Timeline');
  });

  it('truncates long step labels', () => {
    const svg = waterfallChart([
      { label: 'A very long step name that exceeds the limit', startSec: 0, durationSec: 10 },
    ]);
    expect(svg).toContain('\u2026');
  });

  it('XML-escapes special characters in labels', () => {
    const svg = waterfallChart([
      { label: '<v2> & "app"', startSec: 0, durationSec: 10 },
    ]);
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
  });

  it('uses CSS variable references for theming', () => {
    const svg = waterfallChart([{ label: 'X', startSec: 0, durationSec: 1 }]);
    expect(svg).toContain('var(--');
  });

  it('positions parallel steps at same x offset', () => {
    const svg = waterfallChart([
      { label: 'A', startSec: 0, durationSec: 100, group: 'build' },
      { label: 'B', startSec: 0, durationSec: 80, group: 'test' },
    ]);
    // Both fill bars should start at the barLeft x (jobLabelW + stepLabelW + padL = 174)
    const fillBars = svg.match(/<rect x="174\.0"/g) ?? [];
    expect(fillBars.length).toBe(2);
  });
});

// ── statCards ───────────────────────────────────────────────

describe('statCards', () => {
  it('returns empty string for empty items', () => {
    expect(statCards([])).toBe('');
  });

  it('returns a valid SVG for normal input', () => {
    const svg = statCards([
      { label: 'Duration', value: '5m 23s' },
      { label: 'CPU', value: '45%' },
    ]);
    expect(svg).toMatch(/^<svg [\s\S]+<\/svg>$/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('contains card values and labels', () => {
    const svg = statCards([
      { label: 'Duration', value: '5m 23s', colorVar: 'accent-cyan' },
      { label: 'Avg CPU', value: '45%', sub: 'peak 89%', colorVar: 'accent-blue' },
    ]);
    expect(svg).toContain('5m 23s');
    expect(svg).toContain('Duration');
    expect(svg).toContain('45%');
    expect(svg).toContain('Avg CPU');
    expect(svg).toContain('peak 89%');
  });

  it('renders colored accent bars referencing CSS vars', () => {
    const svg = statCards([
      { label: 'CPU', value: '45%', colorVar: 'accent-blue' },
    ]);
    expect(svg).toContain('var(--accent-blue)');
  });

  it('uses card background', () => {
    const svg = statCards([{ label: 'X', value: '1' }]);
    expect(svg).toContain('var(--bg-card)');
  });

  it('uses CSS variable references for theming', () => {
    const svg = statCards([{ label: 'X', value: '1' }]);
    expect(svg).toContain('var(--');
  });

  it('renders 4 cards without issue', () => {
    const svg = statCards([
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
      { label: 'C', value: '3' },
      { label: 'D', value: '4' },
    ]);
    expect(svg).toContain('>1<');
    expect(svg).toContain('>4<');
  });
});
