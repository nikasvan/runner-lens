// ─────────────────────────────────────────────────────────────
// RunnerLens — Test Suite
// ─────────────────────────────────────────────────────────────

import { stats, safeMax, safeMin, safePct } from '../src/stats';
import { sparkline, intensityBar, fmtBytes, fmtDuration, progressBar, statusDot } from '../src/charts';
import { evaluateAlerts } from '../src/alerts';
import { recommend } from '../src/recommendations';
import { processMetrics } from '../src/reporter';
import { correlateSteps, fetchSteps, fetchStepsFromRuntime } from '../src/steps';
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
    sampleInterval: 3,
    includeProcesses: true,
    summaryStyle: 'full',
    maxSizeMb: 100,
    apiKey: '',
    apiEndpoint: 'https://api.runnerlens.com',
    githubToken: '',
    thresholds: { cpu_warn: 80, cpu_crit: 95, mem_warn: 80, mem_crit: 95 },
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

describe('safeMin', () => {
  it('finds min on large arrays', () => {
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    expect(safeMin(big)).toBe(0);
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

describe('sparkline', () => {
  it('returns empty string for < 2 values', () => {
    expect(sparkline([])).toBe('');
    expect(sparkline([42])).toBe('');
  });

  it('produces characters from the spark set', () => {
    const line = sparkline([0, 25, 50, 75, 100], 5);
    expect(line).toHaveLength(5);
    expect(line).toMatch(/^[▁▂▃▄▅▆▇█]+$/);
  });

  it('resamples long arrays without crashing', () => {
    const values = Array.from({ length: 1000 }, () => Math.random() * 100);
    const line = sparkline(values, 52);
    expect(line).toHaveLength(52);
  });
});

describe('intensityBar', () => {
  it('produces block characters', () => {
    const bar = intensityBar([10, 30, 50, 70, 90], 5);
    expect(bar).toHaveLength(5);
  });
});

describe('progressBar', () => {
  it('produces correct width', () => {
    expect(progressBar(50, 10)).toHaveLength(10);
    expect(progressBar(0, 10)).toBe('░░░░░░░░░░');
    expect(progressBar(100, 10)).toBe('██████████');
  });

  it('clamps values', () => {
    expect(progressBar(-10, 5)).toBe('░░░░░');
    expect(progressBar(200, 5)).toBe('█████');
  });
});

describe('statusDot', () => {
  it('returns green for low values', () => expect(statusDot(50)).toBe('🟢'));
  it('returns yellow for warning', () => expect(statusDot(85)).toBe('🟡'));
  it('returns red for critical', () => expect(statusDot(96)).toBe('🔴'));
});

describe('fmtBytes', () => {
  it('formats zero', () => expect(fmtBytes(0)).toBe('0 B'));
  it('formats KB', () => expect(fmtBytes(1024)).toBe('1 KB'));
  it('formats MB', () => expect(fmtBytes(1.5 * 1024 * 1024)).toBe('1.5 MB'));
  it('formats GB', () => expect(fmtBytes(2.3 * 1024 ** 3)).toBe('2.3 GB'));
});

describe('fmtDuration', () => {
  it('formats seconds', () => expect(fmtDuration(45)).toBe('45s'));
  it('formats minutes', () => expect(fmtDuration(125)).toBe('2m 5s'));
  it('formats hours', () => expect(fmtDuration(3723)).toBe('1h 2m'));
  it('formats exact minutes', () => expect(fmtDuration(120)).toBe('2m'));
});

// ─────────────────────────────────────────────────────────────
// alerts.ts
// ─────────────────────────────────────────────────────────────

describe('evaluateAlerts', () => {
  it('returns no alerts when everything is healthy', () => {
    const samples = [makeSample(), makeSample()];
    const cpuStats = stats(samples.map((s) => s.cpu.usage));
    const memStats = stats(samples.map((s) => s.memory.used_mb));
    const alerts = evaluateAlerts(samples, makeConfig(), cpuStats, memStats, 7168);
    expect(alerts).toEqual([]);
  });

  it('raises critical CPU alert when average exceeds critical threshold', () => {
    const sample = makeSample({ cpu: { user: 90, system: 5, idle: 3, iowait: 1, steal: 1, usage: 97 } });
    const samples = Array(20).fill(sample);
    const cpuStats = stats(samples.map((s) => s.cpu.usage));
    const memStats = stats(samples.map((s) => s.memory.used_mb));
    const alerts = evaluateAlerts(samples, makeConfig(), cpuStats, memStats, 7168);
    expect(alerts.some((a) => a.level === 'critical' && a.metric === 'CPU')).toBe(true);
  });

  it('raises swap warning when swap is used across >10% of samples', () => {
    const swapSample = makeSample({
      memory: { total_mb: 7168, used_mb: 6800, available_mb: 368, cached_mb: 128, swap_total_mb: 2048, swap_used_mb: 512, usage_pct: 94.9 },
    });
    const normalSample = makeSample();
    // 3 out of 5 = 60% → should trigger
    const samples = [swapSample, swapSample, swapSample, normalSample, normalSample];
    const cpuStats = stats(samples.map((s) => s.cpu.usage));
    const memStats = stats(samples.map((s) => s.memory.used_mb));
    const alerts = evaluateAlerts(samples, makeConfig(), cpuStats, memStats, 7168);
    expect(alerts.some((a) => a.metric === 'Swap')).toBe(true);
  });

  it('returns empty array for empty samples', () => {
    const cpuStats = stats([]);
    const memStats = stats([]);
    expect(evaluateAlerts([], makeConfig(), cpuStats, memStats, 0)).toEqual([]);
  });

  it('handles zero memTotal without division by zero', () => {
    const samples = [makeSample()];
    const cpuStats = stats(samples.map((s) => s.cpu.usage));
    const memStats = stats(samples.map((s) => s.memory.used_mb));
    // memTotalMb = 0 → safePct should return 0, no NaN
    const alerts = evaluateAlerts(samples, makeConfig(), cpuStats, memStats, 0);
    expect(alerts.every((a) => !isNaN(a.value))).toBe(true);
  });

});

// ─────────────────────────────────────────────────────────────
// recommendations.ts
// ─────────────────────────────────────────────────────────────

describe('recommend', () => {
  it('recommends smaller runner when resources are underused', () => {
    const sample = makeSample({
      cpu: { user: 5, system: 3, idle: 90, iowait: 1, steal: 1, usage: 10 },
      memory: { total_mb: 7168, used_mb: 1024, available_mb: 6144, cached_mb: 512, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 14.3 },
    });
    const { report } = processMetrics([sample, sample], makeSysInfo(), makeConfig(), 60);
    expect(report.recommendations.some((r) => r.includes('Oversized'))).toBe(true);
  });

  it('recommends larger runner when CPU is saturated on 2-core', () => {
    const sample = makeSample({
      cpu: { user: 85, system: 10, idle: 3, iowait: 1, steal: 1, usage: 97 },
    });
    const samples = Array(20).fill(sample);
    const sysInfo = makeSysInfo(); // 2 cores
    const { report } = processMetrics(samples, sysInfo, makeConfig(), 120);
    expect(report.recommendations.some((r) => r.includes('CPU saturated'))).toBe(true);
  });

  it('returns empty for empty samples', () => {
    expect(recommend({
      version: '1.0.0', system: makeSysInfo(),
      duration_seconds: 0, sample_count: 0,
      started_at: '', ended_at: '',
      cpu: stats([]), memory: { ...stats([]), total_mb: 0, swap_max_mb: 0 },
      load: { avg_1m: 0, max_1m: 0 },
      top_processes: [], alerts: [], recommendations: [],
    }, [])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// reporter.ts — processMetrics integration
// ─────────────────────────────────────────────────────────────

describe('processMetrics', () => {
  it('produces a complete report and markdown', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const { report, markdown } = processMetrics(
      [s1, s2], makeSysInfo(), makeConfig(), 6,
    );

    // Report fields
    expect(report.version).toBe('1.0.0');
    expect(report.sample_count).toBe(2);
    expect(report.duration_seconds).toBe(6);
    expect(report.cpu.avg).toBe(45);
    expect(report.memory.total_mb).toBe(7168);

    // New markdown format
    expect(markdown).toContain('RunnerLens');
    expect(markdown).toContain('Dashboard');
    expect(markdown).toContain('**CPU**');
    expect(markdown).toContain('**Memory**');
    expect(markdown).toContain('█'); // progress bars
  });

  it('handles zero-duration gracefully (no NaN/Infinity)', () => {
    const s = makeSample();
    const { report } = processMetrics([s], makeSysInfo(), makeConfig(), 0);
    expect(Number.isFinite(report.cpu.avg)).toBe(true);
    expect(Number.isFinite(report.memory.avg)).toBe(true);
  });

  it('produces no markdown when summaryStyle is none', () => {
    const s = makeSample();
    const { markdown } = processMetrics(
      [s, s], makeSysInfo(), makeConfig({ summaryStyle: 'none' }), 60,
    );
    expect(markdown).toBe('');
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

  it('generates timeline in full and compact but not minimal', () => {
    const samples = Array(10).fill(null).map((_, i) =>
      makeSample({ timestamp: 1700000000 + i * 3, cpu: { user: i * 10, system: 5, idle: 85 - i * 10, iowait: 0, steal: 0, usage: i * 10 + 5 } }),
    );
    const full = processMetrics(samples, makeSysInfo(), makeConfig({ summaryStyle: 'full' }), 30);
    const minimal = processMetrics(samples, makeSysInfo(), makeConfig({ summaryStyle: 'minimal' }), 30);
    expect(full.markdown).toContain('Timeline');
    expect(minimal.markdown).not.toContain('Timeline');
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

  it('shows collector info in footer', () => {
    const s = makeSample({ collector: { cpu_pct: 0.5, mem_mb: 3.2 } });
    const { markdown } = processMetrics([s, s], makeSysInfo(), makeConfig(), 6);
    expect(markdown).toContain('Sampling:');
    expect(markdown).toContain('0.5% CPU');
  });
});

// ─────────────────────────────────────────────────────────────
// per-step markdown
// ─────────────────────────────────────────────────────────────

describe('per-step markdown', () => {
  it('renders per-step table when steps provided', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const steps: StepMetrics[] = [
      { name: 'Checkout', number: 1, duration_seconds: 5, cpu_avg: 23, cpu_max: 45, mem_avg_mb: 1200, mem_max_mb: 1500, sample_count: 2 },
      { name: 'Build', number: 2, duration_seconds: 120, cpu_avg: 67, cpu_max: 95, mem_avg_mb: 2300, mem_max_mb: 3100, sample_count: 40 },
    ];
    const { markdown } = processMetrics([s1, s2], makeSysInfo(), makeConfig(), 6, steps);
    expect(markdown).toContain('Per-Step Breakdown');
    expect(markdown).toContain('Checkout');
    expect(markdown).toContain('Build');
  });

  it('omits per-step table when no steps', () => {
    const s = makeSample();
    const { markdown } = processMetrics([s, s], makeSysInfo(), makeConfig(), 6);
    expect(markdown).not.toContain('Per-Step Breakdown');
  });
});

// ─────────────────────────────────────────────────────────────
// fetchStepsFromRuntime
// ─────────────────────────────────────────────────────────────

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

describe('fetchStepsFromRuntime', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns empty when ACTIONS_RUNTIME_URL is missing', async () => {
    delete process.env.ACTIONS_RUNTIME_URL;
    delete process.env.ACTIONS_RUNTIME_TOKEN;
    const result = await fetchStepsFromRuntime();
    expect(result).toEqual([]);
  });

  it('returns empty when token has no plan_id', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'test' })).toString('base64url');
    process.env.ACTIONS_RUNTIME_URL = 'https://example.com/';
    process.env.ACTIONS_RUNTIME_TOKEN = `header.${payload}.signature`;
    const result = await fetchStepsFromRuntime();
    expect(result).toEqual([]);
  });

  it('throws on network error (caught by caller)', async () => {
    const payload = Buffer.from(JSON.stringify({ plan_id: 'test-plan' })).toString('base64url');
    process.env.ACTIONS_RUNTIME_URL = 'https://localhost:1/';
    process.env.ACTIONS_RUNTIME_TOKEN = `header.${payload}.signature`;
    await expect(fetchStepsFromRuntime()).rejects.toThrow();
  });

  it('returns empty when token is malformed', async () => {
    process.env.ACTIONS_RUNTIME_URL = 'https://example.com/';
    process.env.ACTIONS_RUNTIME_TOKEN = 'not-a-jwt';
    const result = await fetchStepsFromRuntime();
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
