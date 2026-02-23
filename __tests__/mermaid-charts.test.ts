// ─────────────────────────────────────────────────────────────
// RunnerLens — Mermaid Charts Test Suite
// ─────────────────────────────────────────────────────────────

import { timelineChart, stepBarChart, workflowTimelineChart, waterfallChart, statCards } from '../src/mermaid-charts';

// ── statCards ───────────────────────────────────────────────

describe('statCards', () => {
  it('returns empty string for empty items', () => {
    expect(statCards([])).toBe('');
  });

  it('returns a markdown table for normal input', () => {
    const md = statCards([
      { label: 'Duration', value: '5m 23s' },
      { label: 'CPU', value: '45%' },
    ]);
    expect(md).toContain('|');
    expect(md).toContain('Duration');
    expect(md).toContain('CPU');
  });

  it('contains card values and labels', () => {
    const md = statCards([
      { label: 'Duration', value: '5m 23s', colorVar: 'accent-cyan' },
      { label: 'Avg CPU', value: '45%', sub: 'peak 89%', colorVar: 'accent-blue' },
    ]);
    expect(md).toContain('**5m 23s**');
    expect(md).toContain('Duration');
    expect(md).toContain('**45%**');
    expect(md).toContain('Avg CPU');
    expect(md).toContain('peak 89%');
  });

  it('renders sub-labels', () => {
    const md = statCards([
      { label: 'CPU', value: '45%', sub: 'peak 89%' },
    ]);
    expect(md).toContain('<sub>peak 89%</sub>');
  });

  it('renders 4 cards without issue', () => {
    const md = statCards([
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
      { label: 'C', value: '3' },
      { label: 'D', value: '4' },
    ]);
    expect(md).toContain('**1**');
    expect(md).toContain('**4**');
  });

  it('has correct table structure with separator', () => {
    const md = statCards([
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
    ]);
    const lines = md.split('\n');
    expect(lines[0]).toMatch(/^\| A \| B \|$/);
    expect(lines[1]).toMatch(/^\|:---:\|:---:\|$/);
    expect(lines[2]).toMatch(/^\| \*\*1\*\* \| \*\*2\*\* \|$/);
  });
});

// ── timelineChart ───────────────────────────────────────────

describe('timelineChart', () => {
  it('returns empty string for fewer than 2 values', () => {
    expect(timelineChart([], [])).toBe('');
    expect(timelineChart([42], [42])).toBe('');
  });

  it('returns a mermaid code block for normal input', () => {
    const cpu = [10, 20, 30, 40, 50];
    const mem = [60, 50, 40, 30, 20];
    const md = timelineChart(cpu, mem);
    expect(md).toContain('```mermaid');
    expect(md).toContain('xychart-beta');
    expect(md).toContain('```');
  });

  it('contains CPU and Memory labels', () => {
    const md = timelineChart([10, 20], [30, 40], { cpuAvg: 15, memAvg: 35 });
    expect(md).toContain('CPU 15% avg');
    expect(md).toContain('Memory 35% avg');
  });

  it('contains y-axis with 0 to 100 range', () => {
    const md = timelineChart([10, 90], [20, 80]);
    expect(md).toContain('0 --> 100');
  });

  it('contains line data', () => {
    const md = timelineChart([10, 20, 30], [40, 50, 60]);
    expect(md).toContain('line [');
  });

  it('handles 1000+ data points without issue', () => {
    const big = Array.from({ length: 2000 }, (_, i) => (i % 100));
    expect(() => timelineChart(big, big)).not.toThrow();
    const md = timelineChart(big, big);
    expect(md).toContain('xychart-beta');
  });

  it('uses dark theme', () => {
    const md = timelineChart([10, 20], [30, 40]);
    expect(md).toContain("'theme': 'dark'");
  });

  it('works when only one series has data', () => {
    const md = timelineChart([10, 20, 30], []);
    expect(md).toContain('xychart-beta');
    expect(md).toContain('line [');
  });

  it('sets CPU and memory colors in palette', () => {
    const md = timelineChart([10, 20], [30, 40]);
    expect(md).toContain('#58a6ff');
    expect(md).toContain('#bc8cff');
  });
});

// ── stepBarChart ────────────────────────────────────────────

describe('stepBarChart', () => {
  it('returns empty string for empty steps', () => {
    expect(stepBarChart([])).toBe('');
  });

  it('returns a mermaid code block for normal input', () => {
    const steps = [
      { name: 'Checkout', value: 5 },
      { name: 'Build', value: 120 },
      { name: 'Test', value: 60 },
    ];
    const md = stepBarChart(steps);
    expect(md).toContain('```mermaid');
    expect(md).toContain('xychart-beta');
    expect(md).toContain('bar [');
  });

  it('includes step names in labels', () => {
    const md = stepBarChart([{ name: 'Build', value: 10 }]);
    expect(md).toContain('Build');
  });

  it('truncates long step names', () => {
    const md = stepBarChart([{ name: 'A very long step name that exceeds the limit', value: 10 }]);
    expect(md).toContain('\u2026'); // ellipsis
  });

  it('uses custom value formatter', () => {
    const md = stepBarChart(
      [{ name: 'Step', value: 125 }],
      { formatValue: (v) => `${Math.floor(v / 60)}m ${v % 60}s` },
    );
    expect(md).toContain('2m 5s');
  });

  it('uses dark theme', () => {
    const md = stepBarChart([{ name: 'X', value: 1 }]);
    expect(md).toContain("'theme': 'dark'");
  });

  it('contains bar data', () => {
    const md = stepBarChart([
      { name: 'A', value: 10 },
      { name: 'B', value: 20 },
    ]);
    expect(md).toContain('bar [10, 20]');
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

  it('returns a mermaid code block for normal input', () => {
    const segments = [
      { label: 'build', values: [10, 20, 30, 40, 50] },
      { label: 'test', values: [60, 70, 80, 90, 95] },
    ];
    const md = workflowTimelineChart(segments, baseOpts);
    expect(md).toContain('```mermaid');
    expect(md).toContain('xychart-beta');
  });

  it('contains title', () => {
    const md = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(md).toContain('CPU Usage');
  });

  it('shows current value in title', () => {
    const md = workflowTimelineChart(
      [{ label: 'job', values: [10, 50, 90] }],
      baseOpts,
    );
    expect(md).toContain('90%');
  });

  it('uses CPU color for cpu-stroke', () => {
    const md = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(md).toContain('#58a6ff');
  });

  it('uses memory color for mem-stroke', () => {
    const md = workflowTimelineChart(
      [{ label: 'job', values: [1024, 2048, 3072] }],
      {
        color: 'mem-stroke',
        fillColor: 'mem-fill',
        yMax: 7168,
        yFormat: (v) => `${(v / 1024).toFixed(1)} GB`,
        title: 'Memory Usage',
      },
    );
    expect(md).toContain('#bc8cff');
    expect(md).toContain('Memory Usage');
  });

  it('handles many data points without issue', () => {
    const big = Array.from({ length: 2000 }, (_, i) => i % 100);
    expect(() => workflowTimelineChart([{ label: 'job', values: big }], baseOpts)).not.toThrow();
  });

  it('uses dark theme', () => {
    const md = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(md).toContain("'theme': 'dark'");
  });

  it('contains line data', () => {
    const md = workflowTimelineChart(
      [{ label: 'job', values: [10, 20, 30] }],
      baseOpts,
    );
    expect(md).toContain('line [');
  });
});

// ── waterfallChart ──────────────────────────────────────────

describe('waterfallChart', () => {
  it('returns empty string for empty steps', () => {
    expect(waterfallChart([])).toBe('');
  });

  it('returns a mermaid gantt code block for normal input', () => {
    const md = waterfallChart([
      { label: 'build · Checkout', startSec: 0, durationSec: 8, group: 'build' },
      { label: 'build · Install', startSec: 8, durationSec: 45, group: 'build' },
      { label: 'test · Run tests', startSec: 53, durationSec: 120, group: 'test' },
    ]);
    expect(md).toContain('```mermaid');
    expect(md).toContain('gantt');
    expect(md).toContain('dateFormat X');
  });

  it('contains step labels and sections', () => {
    const md = waterfallChart([
      { label: 'build · Checkout', startSec: 0, durationSec: 8, group: 'build' },
      { label: 'test · Run tests', startSec: 8, durationSec: 120, group: 'test' },
    ]);
    expect(md).toContain('section build');
    expect(md).toContain('Checkout');
    expect(md).toContain('section test');
    expect(md).toContain('Run tests');
  });

  it('contains duration labels', () => {
    const md = waterfallChart([
      { label: 'Step A', startSec: 0, durationSec: 125, group: 'job' },
    ]);
    expect(md).toContain('2m 5s');
  });

  it('uses custom duration formatter', () => {
    const md = waterfallChart(
      [{ label: 'Step A', startSec: 0, durationSec: 90, group: 'job' }],
      { formatDuration: (s) => `${s} sec` },
    );
    expect(md).toContain('90 sec');
  });

  it('groups steps by job into sections', () => {
    const md = waterfallChart([
      { label: 'A', startSec: 0, durationSec: 10, group: 'build' },
      { label: 'B', startSec: 10, durationSec: 20, group: 'test' },
    ]);
    expect(md).toContain('section build');
    expect(md).toContain('section test');
  });

  it('uses dark theme', () => {
    const md = waterfallChart([{ label: 'X', startSec: 0, durationSec: 1 }]);
    expect(md).toContain('"theme": "dark"');
  });

  it('includes title when provided', () => {
    const md = waterfallChart(
      [{ label: 'X', startSec: 0, durationSec: 1 }],
      { title: 'Execution Timeline' },
    );
    expect(md).toContain('Execution Timeline');
  });

  it('truncates long step labels', () => {
    const md = waterfallChart([
      { label: 'A very long step name that exceeds the limit', startSec: 0, durationSec: 10 },
    ]);
    expect(md).toContain('\u2026');
  });

  it('positions parallel steps by start/end time', () => {
    const md = waterfallChart([
      { label: 'A', startSec: 0, durationSec: 100, group: 'build' },
      { label: 'B', startSec: 0, durationSec: 80, group: 'test' },
    ]);
    // Both should start at 0
    expect(md).toContain(':0, ');
  });

  it('uses correct start and end timestamps', () => {
    const md = waterfallChart([
      { label: 'Step', startSec: 10, durationSec: 30, group: 'job' },
    ]);
    // start=10, end=40
    expect(md).toContain(':10, 40');
  });
});
