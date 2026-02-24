// ─────────────────────────────────────────────────────────────
// RunnerLens — Test Suite
// ─────────────────────────────────────────────────────────────

import { stats, safeMax, safePct } from '../src/stats';
import { processMetrics } from '../src/reporter';
import { correlateSteps, fetchSteps } from '../src/steps';
import {
  renderStatCards, renderAreaChart, renderGanttChart, svgImg,
} from '../src/svg-charts';
import { buildJobSummary } from '../src/job-summary';
import type {
  MetricSample, SystemInfo, MonitorConfig, AggregatedReport,
} from '../src/types';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeSample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    timestamp: 1700000000,
    cpu: {
      user: 30, system: 10, idle: 55, iowait: 3, steal: 2, usage: 45,
    },
    memory: {
      total_mb: 7168, used_mb: 3072, available_mb: 4096,
      cached_mb: 1024, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 42.9,
    },
    load: { load1: 1.5, load5: 1.2, load15: 0.9 },
    processes: [
      { pid: 100, name: 'node', cpu_pct: 35.0, mem_mb: 256 },
      { pid: 101, name: 'npm', cpu_pct: 10.0, mem_mb: 128 },
    ],
    collector: { cpu_pct: 0.2, mem_mb: 3.5 },
    ...overrides,
  };
}

function makeSysInfo(): SystemInfo {
  return {
    cpu_count: 2,
    cpu_model: 'AMD EPYC',
    total_memory_mb: 7168,
    os_release: 'Ubuntu 22.04.3 LTS',
    kernel: '6.2.0-1018-azure',
    runner_name: 'GitHub Actions 2',
    runner_os: 'Linux',
    runner_arch: 'X64',
  };
}

function makeConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    mode: 'monitor',
    sampleInterval: 3,
    maxSizeMb: 100,
    githubToken: '',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// stats.ts
// ─────────────────────────────────────────────────────────────

describe('stats', () => {
  it('returns zeroes for empty array', () => {
    const s = stats([]);
    expect(s.avg).toBe(0);
    expect(s.max).toBe(0);
    expect(s.p95).toBe(0);
  });

  it('computes correct stats for a known dataset', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const s = stats(values);
    expect(s.avg).toBe(55);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.latest).toBe(100);
  });

  it('handles single-element array', () => {
    const s = stats([42]);
    expect(s.avg).toBe(42);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.p50).toBe(42);
    expect(s.p95).toBe(42);
  });
});

describe('safeMax', () => {
  it('returns fallback for empty array', () => {
    expect(safeMax([], -1)).toBe(-1);
    expect(safeMax([])).toBe(0);
  });

  it('finds max without stack overflow on large arrays', () => {
    // Math.max(...arr) would throw RangeError here
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    expect(safeMax(big)).toBe(199_999);
  });

  it('handles negative values', () => {
    expect(safeMax([-5, -3, -10])).toBe(-3);
  });
});

describe('safePct', () => {
  it('returns 0 when denominator is 0', () => {
    expect(safePct(100, 0)).toBe(0);
  });

  it('calculates correct percentage', () => {
    expect(safePct(50, 200)).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────
// reporter.ts — processMetrics integration
// ─────────────────────────────────────────────────────────────

describe('processMetrics', () => {
  it('produces a complete report', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const { report } = processMetrics(
      [s1, s2], makeSysInfo(), makeConfig(), 6,
    );

    // Report fields
    expect(report.version).toBe('1.0.0');
    expect(report.sample_count).toBe(2);
    expect(report.duration_seconds).toBe(6);
    expect(report.cpu.avg).toBe(45);
    expect(report.memory.total_mb).toBe(7168);
  });

  it('handles zero-duration gracefully (no NaN/Infinity)', () => {
    const s = makeSample();
    const { report } = processMetrics([s], makeSysInfo(), makeConfig(), 0);
    expect(Number.isFinite(report.cpu.avg)).toBe(true);
    expect(Number.isFinite(report.memory.avg)).toBe(true);
  });

  it('deduplicates top processes by name keeping highest CPU', () => {
    const s1 = makeSample({
      processes: [{ pid: 1, name: 'node', cpu_pct: 20, mem_mb: 100 }],
    });
    const s2 = makeSample({
      processes: [{ pid: 1, name: 'node', cpu_pct: 80, mem_mb: 200 }],
    });
    const { report } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6);
    const nodeProcs = report.top_processes.filter((p) => p.name === 'node');
    expect(nodeProcs).toHaveLength(1);
    expect(nodeProcs[0].cpu_pct).toBe(80);
  });

  it('includes swap_max_mb in memory stats', () => {
    const s = makeSample({
      memory: { total_mb: 7168, used_mb: 6000, available_mb: 1168, cached_mb: 512, swap_total_mb: 2048, swap_used_mb: 768, usage_pct: 83.7 },
    });
    const { report } = processMetrics([s], makeSysInfo(), makeConfig(), 3);
    expect(report.memory.swap_max_mb).toBe(768);
  });

  it('includes timeline with correct length for multiple samples', () => {
    const samples = Array(100).fill(null).map((_, i) =>
      makeSample({
        timestamp: 1700000000 + i * 3,
        cpu: { user: 30, system: 10, idle: 55, iowait: 3, steal: 2, usage: 40 + i * 0.5 },
        memory: { total_mb: 7168, used_mb: 2000 + i * 10, available_mb: 5168, cached_mb: 1024, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 30 },
      }),
    );
    const { report } = processMetrics(samples, makeSysInfo(), makeConfig(), 300);
    expect(report.timeline).toBeDefined();
    expect(report.timeline!.cpu_pct).toHaveLength(80);
    expect(report.timeline!.mem_mb).toHaveLength(80);
  });

  it('omits timeline for single sample', () => {
    const { report } = processMetrics([makeSample()], makeSysInfo(), makeConfig(), 3);
    expect(report.timeline).toBeUndefined();
  });

  it('includes steps when passed to processMetrics', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const steps = [
      { name: 'Checkout', number: 1, duration_seconds: 3, cpu_avg: 30, cpu_max: 45, mem_avg_mb: 2048, mem_max_mb: 3072, sample_count: 1, started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:23Z' },
      { name: 'Build', number: 2, duration_seconds: 3, cpu_avg: 60, cpu_max: 90, mem_avg_mb: 3072, mem_max_mb: 5120, sample_count: 1, started_at: '2023-11-14T22:13:23Z', completed_at: '2023-11-14T22:13:26Z' },
    ];
    const { report } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6, steps);
    expect(report.steps).toHaveLength(2);
    expect(report.steps![0].name).toBe('Checkout');
  });

  it('omits steps when empty array is passed', () => {
    const s = makeSample();
    const { report } = processMetrics([s, s], makeSysInfo(), makeConfig(), 6, []);
    expect(report.steps).toBeUndefined();
  });

  it('includes timeline with original length when fewer than 80 samples', () => {
    const samples = Array(10).fill(null).map((_, i) =>
      makeSample({ timestamp: 1700000000 + i * 3 }),
    );
    const { report } = processMetrics(samples, makeSysInfo(), makeConfig(), 30);
    expect(report.timeline).toBeDefined();
    expect(report.timeline!.cpu_pct).toHaveLength(10);
    expect(report.timeline!.mem_mb).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────
// steps.ts — correlateSteps
// ─────────────────────────────────────────────────────────────

describe('correlateSteps', () => {
  it('maps samples to step time windows', () => {
    const samples = [
      makeSample({ timestamp: 1700000000 }),
      makeSample({ timestamp: 1700000003 }),
      makeSample({ timestamp: 1700000006 }),
      makeSample({ timestamp: 1700000009, cpu: { user: 80, system: 10, idle: 5, iowait: 3, steal: 2, usage: 95 } }),
      makeSample({ timestamp: 1700000012 }),
    ];

    const steps = correlateSteps(
      [
        { name: 'Checkout', number: 1, status: 'completed', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:26Z' },
        { name: 'Build', number: 2, status: 'completed', started_at: '2023-11-14T22:13:27Z', completed_at: '2023-11-14T22:13:33Z' },
      ],
      samples,
    );

    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('Checkout');
    expect(steps[0].duration_seconds).toBe(6);
    expect(steps[0].sample_count).toBe(3); // timestamps 0, 3, 6
    expect(steps[0].started_at).toBe('2023-11-14T22:13:20Z');
    expect(steps[0].completed_at).toBe('2023-11-14T22:13:26Z');
    expect(steps[1].name).toBe('Build');
    expect(steps[1].sample_count).toBe(2); // timestamps 9, 12
    expect(steps[1].cpu_max).toBe(95);
    expect(steps[1].started_at).toBe('2023-11-14T22:13:27Z');
    expect(steps[1].completed_at).toBe('2023-11-14T22:13:33Z');
  });

  it('returns empty for empty inputs', () => {
    expect(correlateSteps([], [makeSample()])).toEqual([]);
    expect(correlateSteps(
      [{ name: 'X', number: 1, status: 'completed', started_at: '2023-01-01T00:00:00Z', completed_at: '2023-01-01T00:01:00Z' }],
      [],
    )).toEqual([]);
  });

  it('handles steps with no matching samples', () => {
    const steps = correlateSteps(
      [{ name: 'Quick', number: 1, status: 'completed', started_at: '2020-01-01T00:00:00Z', completed_at: '2020-01-01T00:00:01Z' }],
      [makeSample({ timestamp: 1700000000 })],
    );
    expect(steps[0].sample_count).toBe(0);
    expect(steps[0].cpu_avg).toBe(0);
    expect(steps[0].started_at).toBe('2020-01-01T00:00:00Z');
    expect(steps[0].completed_at).toBe('2020-01-01T00:00:01Z');
  });

  it('handles step with null completed_at (still in-progress)', () => {
    const samples = [
      makeSample({ timestamp: 1700000000 }),
      makeSample({ timestamp: 1700000003 }),
    ];
    const steps = correlateSteps(
      [{ name: 'Running', number: 1, status: 'in_progress', started_at: '2023-11-14T22:13:20Z', completed_at: null }],
      samples,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('Running');
    expect(steps[0].completed_at).toBeTruthy();
  });

  it('skips steps without started_at', () => {
    const steps = correlateSteps(
      [
        { name: 'Pending', number: 1, status: 'queued', started_at: null, completed_at: null },
        { name: 'Done', number: 2, status: 'completed', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:30Z' },
      ],
      [makeSample({ timestamp: 1700000000 })],
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('Done');
  });
});

// ─────────────────────────────────────────────────────────────
// collector self-monitoring
// ─────────────────────────────────────────────────────────────

describe('collector stats', () => {
  it('includes collector overhead in report', () => {
    const s = makeSample({ collector: { cpu_pct: 0.3, mem_mb: 4.0 } });
    const { report } = processMetrics([s, s], makeSysInfo(), makeConfig(), 6);
    expect(report.collector).toBeDefined();
    expect(report.collector!.avg_cpu_pct).toBeCloseTo(0.3);
    expect(report.collector!.avg_mem_mb).toBeCloseTo(4.0);
    expect(report.collector!.max_mem_mb).toBeCloseTo(4.0);
  });

  it('omits collector stats when samples lack collector field', () => {
    const s = makeSample({ collector: undefined });
    const { report } = processMetrics([s], makeSysInfo(), makeConfig(), 3);
    expect(report.collector).toBeUndefined();
  });
});

describe('fetchSteps (GitHub API)', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns empty when GITHUB env vars are missing', async () => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_JOB;
    const result = await fetchSteps('fake-token');
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Edge cases & safety
// ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('safeMax handles array larger than call stack limit', () => {
    // Proves this is stack-safe unlike Math.max(...arr)
    const huge = new Array(500_000).fill(0).map((_, i) => i % 100);
    expect(() => safeMax(huge)).not.toThrow();
    expect(safeMax(huge)).toBe(99);
  });

  it('safePct with zero total_mb does not produce NaN', () => {
    const result = safePct(3072, 0);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('processMetrics with a single sample does not crash', () => {
    const s = makeSample();
    expect(() => processMetrics([s], makeSysInfo(), makeConfig(), 3)).not.toThrow();
  });

  it('reporter handles samples with missing optional fields', () => {
    const sparse: MetricSample = {
      timestamp: 1700000000,
      cpu: { user: 10, system: 5, idle: 85, iowait: 0, steal: 0, usage: 15 },
      memory: { total_mb: 4096, used_mb: 1024, available_mb: 3072, cached_mb: 512, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 25 },
      load: { load1: 0, load5: 0, load15: 0 },
      processes: [],
    };
    const { report } = processMetrics([sparse], makeSysInfo(), makeConfig(), 3);
    expect(report.top_processes).toEqual([]);
    expect(report.collector).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// svg-charts.ts
// ─────────────────────────────────────────────────────────────

describe('renderStatCards', () => {
  it('produces valid SVG with 4 cards', () => {
    const svg = renderStatCards([
      { label: 'Runner', value: 'Linux', sub: '2 CPU', color: '#3fb950' },
      { label: 'Duration', value: '5m 30s', color: '#58a6ff' },
      { label: 'Avg CPU', value: '45.2%', sub: 'peak 92%', color: '#f0883e' },
      { label: 'Memory', value: '3.0 GB', sub: 'of 7.0 GB', color: '#bc8cff' },
    ]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Linux');
    expect(svg).toContain('45.2%');
    expect(svg).toContain('3.0 GB');
  });
});

describe('renderAreaChart', () => {
  it('produces valid SVG with curve and gradient', () => {
    const svg = renderAreaChart({
      title: 'CPU Usage',
      values: [10, 30, 50, 45, 60, 80, 70],
      color: '#58a6ff',
      yLabel: 'CPU %',
      startedAt: '2023-11-14T22:13:20Z',
      endedAt: '2023-11-14T22:20:00Z',
      currentValue: '70%',
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('CPU Usage');
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('70%');
  });

  it('renders step separators when steps provided', () => {
    const svg = renderAreaChart({
      title: 'CPU',
      values: [10, 20, 30, 40, 50],
      color: '#58a6ff',
      yLabel: '%',
      startedAt: '2023-11-14T22:13:20Z',
      endedAt: '2023-11-14T22:15:20Z',
      steps: [
        { name: 'Build', startedAt: '2023-11-14T22:14:00Z' },
        { name: 'Test', startedAt: '2023-11-14T22:14:40Z' },
      ],
    });
    expect(svg).toContain('Build');
    expect(svg).toContain('Test');
    expect(svg).toContain('stroke-dasharray');
  });

  it('handles 2 data points without error', () => {
    const svg = renderAreaChart({
      title: 'CPU',
      values: [10, 90],
      color: '#58a6ff',
      yLabel: '%',
      startedAt: '2023-01-01T00:00:00Z',
      endedAt: '2023-01-01T00:01:00Z',
    });
    expect(svg).toContain('<svg');
  });

  it('handles flat segments (delta=0) in monotone interpolation', () => {
    // Consecutive equal values trigger the delta[i]===0 branch
    const svg = renderAreaChart({
      title: 'Flat',
      values: [50, 50, 50, 80, 80, 80, 30],
      color: '#58a6ff',
      yLabel: '%',
      startedAt: '2023-01-01T00:00:00Z',
      endedAt: '2023-01-01T00:01:00Z',
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('C'); // cubic bezier commands
  });

  it('handles steep changes that trigger Fritsch-Carlson constraint', () => {
    // Monotonically increasing with wildly different slopes triggers tau > 9:
    // delta[0]=10, delta[1]=1, delta[2]=89 → tangent at [1] = 5.5, alpha=5.5/1 >> 3
    const svg = renderAreaChart({
      title: 'Spike',
      values: [0, 10, 11, 100, 101, 102, 200],
      color: '#58a6ff',
      yLabel: '%',
      startedAt: '2023-01-01T00:00:00Z',
      endedAt: '2023-01-01T00:01:00Z',
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('C'); // smooth bezier curve
  });

  it('skips step separators at edges (frac <= 0.01 or >= 0.99)', () => {
    const svg = renderAreaChart({
      title: 'CPU',
      values: [10, 20, 30],
      color: '#58a6ff',
      yLabel: '%',
      startedAt: '2023-11-14T22:13:20Z',
      endedAt: '2023-11-14T22:15:20Z',
      steps: [
        // At the very start — should be skipped
        { name: 'Start', startedAt: '2023-11-14T22:13:20Z' },
        // At the very end — should be skipped
        { name: 'End', startedAt: '2023-11-14T22:15:19Z' },
      ],
    });
    expect(svg).not.toContain('stroke-dasharray');
  });
});

describe('renderGanttChart', () => {
  it('produces valid SVG with step bars', () => {
    const svg = renderGanttChart({
      steps: [
        { name: 'Checkout', startedAt: '2023-11-14T22:13:20Z', completedAt: '2023-11-14T22:13:26Z', durationSec: 6, color: '#3fb950' },
        { name: 'Build', startedAt: '2023-11-14T22:13:27Z', completedAt: '2023-11-14T22:14:27Z', durationSec: 60, color: '#58a6ff' },
        { name: 'Test', startedAt: '2023-11-14T22:14:28Z', completedAt: '2023-11-14T22:15:00Z', durationSec: 32, color: '#bc8cff' },
      ],
      totalStartedAt: '2023-11-14T22:13:20Z',
      totalEndedAt: '2023-11-14T22:15:00Z',
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Checkout');
    expect(svg).toContain('Build');
    expect(svg).toContain('Test');
    expect(svg).toContain('Execution Timeline');
  });
});

describe('svgImg', () => {
  it('encodes SVG as base64 img tag', () => {
    const html = svgImg('<svg>test</svg>', 'test chart');
    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    expect(html).toContain('alt="test chart"');
    // Verify base64 decodes back
    const b64 = html.match(/base64,([^"]+)/)?.[1];
    expect(Buffer.from(b64!, 'base64').toString()).toBe('<svg>test</svg>');
  });
});

// ─────────────────────────────────────────────────────────────
// job-summary.ts
// ─────────────────────────────────────────────────────────────

describe('buildJobSummary', () => {
  function makeReport(overrides: Partial<AggregatedReport> = {}): AggregatedReport {
    return {
      version: '1.0.0',
      system: makeSysInfo(),
      duration_seconds: 300,
      sample_count: 100,
      started_at: '2023-11-14T22:13:20Z',
      ended_at: '2023-11-14T22:18:20Z',
      cpu: { avg: 45, max: 92, min: 5, p50: 42, p95: 85, p99: 90, latest: 70 },
      memory: { avg: 3072, max: 5120, min: 1024, p50: 3000, p95: 4800, p99: 5000, latest: 3500, total_mb: 7168, swap_max_mb: 0 },
      load: { avg_1m: 1.5, max_1m: 3.2 },
      top_processes: [],
      ...overrides,
    };
  }

  it('produces summary with stat cards', () => {
    const html = buildJobSummary(makeReport());
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('RunnerLens');
  });

  it('includes area charts when timeline has >= 2 points', () => {
    const html = buildJobSummary(makeReport({
      timeline: {
        cpu_pct: [10, 20, 30, 40, 50],
        mem_mb: [1024, 2048, 3072, 2048, 1024],
      },
    }));
    // Should have multiple base64 images (stat cards + 2 area charts)
    const imgCount = (html.match(/data:image\/svg\+xml;base64,/g) || []).length;
    expect(imgCount).toBeGreaterThanOrEqual(3);
  });

  it('includes Gantt chart when steps are present', () => {
    const html = buildJobSummary(makeReport({
      steps: [
        { name: 'Checkout', number: 1, duration_seconds: 6, cpu_avg: 20, cpu_max: 40, mem_avg_mb: 1024, mem_max_mb: 2048, sample_count: 2, started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:26Z' },
        { name: 'Build', number: 2, duration_seconds: 60, cpu_avg: 60, cpu_max: 92, mem_avg_mb: 3072, mem_max_mb: 5120, sample_count: 20, started_at: '2023-11-14T22:13:27Z', completed_at: '2023-11-14T22:14:27Z' },
      ],
      timeline: {
        cpu_pct: [10, 20, 30, 40, 50],
        mem_mb: [1024, 2048, 3072, 2048, 1024],
      },
    }));
    // stat cards + 2 area charts + gantt = 4
    const imgCount = (html.match(/data:image\/svg\+xml;base64,/g) || []).length;
    expect(imgCount).toBe(4);
  });

  it('skips charts gracefully when no timeline data', () => {
    const html = buildJobSummary(makeReport({ timeline: undefined }));
    // Only stat cards
    const imgCount = (html.match(/data:image\/svg\+xml;base64,/g) || []).length;
    expect(imgCount).toBe(1);
  });

  it('includes footer with version', () => {
    const html = buildJobSummary(makeReport());
    expect(html).toContain('v1.0.0');
    expect(html).toContain('runnerlens/runner-lens');
  });

  it('formats duration >= 60s as minutes in stat cards', () => {
    const html = buildJobSummary(makeReport({ duration_seconds: 120 }));
    // Verify base64-encoded SVGs exist (the '2m' is inside the SVG)
    expect(html).toContain('data:image/svg+xml;base64,');
  });

  it('formats memory < 1024 MB as MB', () => {
    const html = buildJobSummary(makeReport({
      memory: { avg: 512, max: 800, min: 100, p50: 500, p95: 750, p99: 780, latest: 600, total_mb: 1024, swap_max_mb: 0 },
    }));
    expect(html).toContain('data:image/svg+xml;base64,');
  });
});
