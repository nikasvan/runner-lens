// ─────────────────────────────────────────────────────────────
// RunnerLens — Summary Module Tests
// ─────────────────────────────────────────────────────────────

jest.mock('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn(),
}));

import { workflowMarkdown } from '../src/summary';
import type {
  MonitorConfig, AggregatedReport, JobReport,
} from '../src/types';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    mode: 'summarize',
    sampleInterval: 3,
    summaryStyle: 'full',
    maxSizeMb: 100,
    apiKey: '',
    apiEndpoint: 'https://api.runnerlens.com',
    githubToken: '',
    ...overrides,
  };
}

function makeReport(overrides: Partial<AggregatedReport> = {}): AggregatedReport {
  return {
    version: '1.0.0',
    system: {
      cpu_count: 2,
      cpu_model: 'AMD EPYC',
      total_memory_mb: 7168,
      os_release: 'Ubuntu 22.04.3 LTS',
      kernel: '6.2.0-1018-azure',
      runner_name: 'GitHub Actions 2',
      runner_os: 'Linux',
      runner_arch: 'X64',
    },
    duration_seconds: 120,
    sample_count: 40,
    started_at: '2023-11-14T22:10:00Z',
    ended_at: '2023-11-14T22:12:00Z',
    cpu: { avg: 45, max: 92, min: 10, p50: 44, p95: 85, p99: 90, latest: 50 },
    memory: { avg: 3072, max: 5120, min: 1024, p50: 3000, p95: 4800, p99: 5000, latest: 3100, total_mb: 7168, swap_max_mb: 0 },
    load: { avg_1m: 1.5, max_1m: 3.2 },
    top_processes: [{ pid: 100, name: 'node', cpu_pct: 35, mem_mb: 256 }],
    timeline: {
      cpu_pct: Array.from({ length: 40 }, (_, i) => 30 + i),
      mem_mb: Array.from({ length: 40 }, (_, i) => 2000 + i * 50),
    },
    ...overrides,
  };
}

function makeJob(name: string, overrides: Partial<AggregatedReport> = {}): JobReport {
  return { jobName: name, report: makeReport(overrides) };
}

// ─────────────────────────────────────────────────────────────
// workflowMarkdown
// ─────────────────────────────────────────────────────────────

describe('workflowMarkdown', () => {
  it('renders header and runner info in stat cards', () => {
    const md = workflowMarkdown([makeJob('build'), makeJob('test')], makeConfig());
    expect(md).toContain('Workflow Summary');
    expect(md).toContain('AMD EPYC');
    expect(md).toContain('7.0 GB RAM');
    expect(md).toContain('Linux');
  });

  it('renders stat cards as HTML table', () => {
    const md = workflowMarkdown(
      [
        makeJob('build', { cpu: { avg: 60, max: 92, min: 10, p50: 55, p95: 85, p99: 90, latest: 50 }, sample_count: 30 }),
        makeJob('test', { cpu: { avg: 30, max: 80, min: 5, p50: 28, p95: 70, p99: 75, latest: 35 }, sample_count: 10 }),
      ],
      makeConfig(),
    );
    expect(md).toContain('<table>');
    expect(md).toContain('<td');
  });

  it('renders timeline sparklines', () => {
    const md = workflowMarkdown([makeJob('build'), makeJob('test')], makeConfig());
    expect(md).toContain('### Timeline');
    expect(md).toContain('```');
    expect(md).toContain('CPU');
    expect(md).toContain('Memory');
    expect(md).toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  it('renders execution timeline when steps exist', () => {
    const md = workflowMarkdown(
      [makeJob('build', {
        steps: [
          { name: 'Checkout', number: 1, duration_seconds: 5, cpu_avg: 23, cpu_max: 45, mem_avg_mb: 1200, mem_max_mb: 1500, sample_count: 2 },
          { name: 'Compile', number: 2, duration_seconds: 90, cpu_avg: 78, cpu_max: 95, mem_avg_mb: 3000, mem_max_mb: 4500, sample_count: 30 },
        ],
      })],
      makeConfig(),
    );
    expect(md).toContain('### Execution Timeline');
    expect(md).toContain('Checkout');
    expect(md).toContain('Compile');
  });

  it('sorts jobs chronologically in execution timeline', () => {
    const steps = [
      { name: 'Run', number: 1, duration_seconds: 30, cpu_avg: 50, cpu_max: 80, mem_avg_mb: 2000, mem_max_mb: 3000, sample_count: 10 },
    ];
    const md = workflowMarkdown(
      [
        makeJob('z-test', { started_at: '2023-11-14T22:15:00Z', steps }),
        makeJob('a-build', { started_at: '2023-11-14T22:10:00Z', steps }),
      ],
      makeConfig(),
    );
    const buildIdx = md.indexOf('a-build');
    const testIdx = md.indexOf('z-test');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(testIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(testIdx);
  });

  it('includes footer with version', () => {
    const md = workflowMarkdown([makeJob('build')], makeConfig());
    expect(md).toContain('RunnerLens');
    expect(md).toContain('Workflow Summary');
  });

  it('handles single job correctly', () => {
    const md = workflowMarkdown([makeJob('deploy')], makeConfig());
    expect(md).toContain('1 job');
    expect(md).not.toContain('1 jobs');
  });

  it('omits timeline when no timeline data exists', () => {
    const md = workflowMarkdown(
      [makeJob('build', { timeline: undefined })],
      makeConfig(),
    );
    expect(md).not.toContain('### Timeline');
  });

  it('omits execution timeline when no steps exist', () => {
    const md = workflowMarkdown([makeJob('build')], makeConfig());
    expect(md).not.toContain('### Execution Timeline');
  });
});
