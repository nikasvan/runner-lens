// ─────────────────────────────────────────────────────────────
// RunnerLens — Test Suite
// ─────────────────────────────────────────────────────────────

import { stats, safeMax, safePct } from '../src/stats';
import { fmtDuration } from '../src/charts';
import { processMetrics, buildJobMarkdown } from '../src/reporter';
import { correlateSteps, fetchSteps } from '../src/steps';
import type {
  MetricSample, SystemInfo, MonitorConfig, StepMetrics,
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

    summaryStyle: 'full',
    maxSizeMb: 100,
    apiKey: '',
    apiEndpoint: 'https://api.runnerlens.com',
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
// charts.ts
// ─────────────────────────────────────────────────────────────

describe('fmtDuration', () => {
  it('formats seconds', () => expect(fmtDuration(45)).toBe('45s'));
  it('formats minutes', () => expect(fmtDuration(125)).toBe('2m 5s'));
  it('formats hours', () => expect(fmtDuration(3723)).toBe('1h 2m'));
  it('formats exact minutes', () => expect(fmtDuration(120)).toBe('2m'));
});

// ─────────────────────────────────────────────────────────────
// reporter.ts — processMetrics integration
// ─────────────────────────────────────────────────────────────

describe('processMetrics', () => {
  it('produces a complete report with SVG charts and quickchart URLs', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const { report, charts, chartUrls } = processMetrics(
      [s1, s2], makeSysInfo(), makeConfig(), 6,
    );

    // Report fields
    expect(report.version).toBe('1.0.0');
    expect(report.sample_count).toBe(2);
    expect(report.duration_seconds).toBe(6);
    expect(report.cpu.avg).toBe(45);
    expect(report.memory.total_mb).toBe(7168);

    // SVG charts for upload
    expect(charts['stat-cards']).toBeDefined();
    expect(charts['stat-cards']).toContain('<svg');
    expect(charts['stat-cards']).toContain('AMD EPYC');

    // Quickchart fallback URLs
    expect(typeof chartUrls).toBe('object');
  });

  it('renders img tags when chart URLs provided', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const { report } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6);

    const md = buildJobMarkdown(report, [s1, s2], makeConfig(), {
      'stat-cards': 'https://raw.githubusercontent.com/test/repo/runner-lens-assets/stat-cards.svg',
      'timeline': 'https://raw.githubusercontent.com/test/repo/runner-lens-assets/timeline.svg',
    });
    expect(md).toContain('RunnerLens');
    expect(md).toContain('<img');
    expect(md).toContain('stat-cards.svg');
  });

  it('falls back to HTML tables when no chart URLs', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const { report } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6);

    const md = buildJobMarkdown(report, [s1, s2], makeConfig());
    expect(md).toContain('RunnerLens');
    expect(md).toContain('<table'); // HTML stat cards fallback
  });

  it('handles zero-duration gracefully (no NaN/Infinity)', () => {
    const s = makeSample();
    const { report } = processMetrics([s], makeSysInfo(), makeConfig(), 0);
    expect(Number.isFinite(report.cpu.avg)).toBe(true);
    expect(Number.isFinite(report.memory.avg)).toBe(true);
  });

  it('produces no charts when summaryStyle is none', () => {
    const s = makeSample();
    const { charts, chartUrls } = processMetrics(
      [s, s], makeSysInfo(), makeConfig({ summaryStyle: 'none' }), 60,
    );
    expect(Object.keys(charts)).toHaveLength(0);
    expect(Object.keys(chartUrls)).toHaveLength(0);
  });

  it('produces no markdown when summaryStyle is none', () => {
    const s = makeSample();
    const { report } = processMetrics(
      [s, s], makeSysInfo(), makeConfig({ summaryStyle: 'none' }), 60,
    );
    const md = buildJobMarkdown(report, [s, s], makeConfig({ summaryStyle: 'none' }));
    expect(md).toBe('');
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

  it('generates timeline charts in full but not minimal', () => {
    const samples = Array(10).fill(null).map((_, i) =>
      makeSample({ timestamp: 1700000000 + i * 3, cpu: { user: i * 10, system: 5, idle: 85 - i * 10, iowait: 0, steal: 0, usage: i * 10 + 5 } }),
    );
    const full = processMetrics(samples, makeSysInfo(), makeConfig({ summaryStyle: 'full' }), 30);
    const minimal = processMetrics(samples, makeSysInfo(), makeConfig({ summaryStyle: 'minimal' }), 30);
    // SVG charts
    expect(full.charts['timeline']).toBeDefined();
    expect(full.charts['timeline']).toContain('<svg');
    expect(minimal.charts['timeline']).toBeUndefined();
    // quickchart fallback URLs
    expect(full.chartUrls['timeline']).toBeDefined();
    expect(full.chartUrls['timeline']).toContain('quickchart.io');
    expect(minimal.chartUrls['timeline']).toBeUndefined();
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
    expect(steps[1].name).toBe('Build');
    expect(steps[1].sample_count).toBe(2); // timestamps 9, 12
    expect(steps[1].cpu_max).toBe(95);
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

  it('shows collector info in markdown fallback', () => {
    const s = makeSample({ collector: { cpu_pct: 0.5, mem_mb: 3.2 } });
    const { report } = processMetrics([s, s], makeSysInfo(), makeConfig(), 6);
    const md = buildJobMarkdown(report, [s, s], makeConfig());
    expect(md).toContain('Sampling:');
    expect(md).toContain('0.5% CPU');
  });
});

// ─────────────────────────────────────────────────────────────
// per-step markdown
// ─────────────────────────────────────────────────────────────

describe('per-step markdown', () => {
  it('does not render per-step breakdown in markdown', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const steps: StepMetrics[] = [
      { name: 'Checkout', number: 1, duration_seconds: 5, cpu_avg: 23, cpu_max: 45, mem_avg_mb: 1200, mem_max_mb: 1500, sample_count: 2 },
      { name: 'Build', number: 2, duration_seconds: 120, cpu_avg: 67, cpu_max: 95, mem_avg_mb: 2300, mem_max_mb: 3100, sample_count: 40 },
    ];
    const { report } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6, steps);
    const md = buildJobMarkdown(report, [s1, s2], makeConfig());
    expect(md).not.toContain('Per-Step Breakdown');
  });

  it('generates step-chart SVG and URL when steps provided', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const steps: StepMetrics[] = [
      { name: 'Checkout', number: 1, duration_seconds: 5, cpu_avg: 23, cpu_max: 45, mem_avg_mb: 1200, mem_max_mb: 1500, sample_count: 2 },
      { name: 'Build', number: 2, duration_seconds: 120, cpu_avg: 67, cpu_max: 95, mem_avg_mb: 2300, mem_max_mb: 3100, sample_count: 40 },
    ];
    const { charts, chartUrls } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6, steps);
    expect(charts['step-chart']).toBeDefined();
    expect(charts['step-chart']).toContain('<svg');
    expect(chartUrls['step-chart']).toBeDefined();
    expect(chartUrls['step-chart']).toContain('quickchart.io');
  });

  it('omits per-step table when no steps', () => {
    const s = makeSample();
    const { report } = processMetrics([s, s], makeSysInfo(), makeConfig(), 6);
    const md = buildJobMarkdown(report, [s, s], makeConfig());
    expect(md).not.toContain('Per-Step Breakdown');
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
