import { workflowMarkdown } from './src/summary';
import type { AggregatedReport, JobReport, MonitorConfig } from './src/types';

function makeConfig(): MonitorConfig {
  return {
    mode: 'summarize', sampleInterval: 3, summaryStyle: 'full',
    maxSizeMb: 100, apiKey: '', apiEndpoint: '', githubToken: '',
  };
}

function makeReport(name: string, startMin: number, durationSec: number, cpuPattern: number[], memPattern: number[]): AggregatedReport {
  const startTime = new Date(`2023-11-14T22:${String(startMin).padStart(2,'0')}:00Z`);
  const endTime = new Date(startTime.getTime() + durationSec * 1000);
  const cpuAvg = cpuPattern.reduce((a,b) => a+b, 0) / cpuPattern.length;
  const memAvg = memPattern.reduce((a,b) => a+b, 0) / memPattern.length;
  return {
    version: '1.0.0',
    system: {
      cpu_count: 2, cpu_model: 'AMD EPYC 7763',
      total_memory_mb: 7168, os_release: 'Ubuntu 22.04.3 LTS',
      kernel: '6.2.0-1018-azure', runner_name: 'GitHub Actions 2',
      runner_os: 'Linux', runner_arch: 'X64',
    },
    duration_seconds: durationSec,
    sample_count: cpuPattern.length,
    started_at: startTime.toISOString(),
    ended_at: endTime.toISOString(),
    cpu: { avg: cpuAvg, max: Math.max(...cpuPattern), min: Math.min(...cpuPattern), p50: cpuAvg, p95: Math.max(...cpuPattern)*0.95, p99: Math.max(...cpuPattern)*0.99, latest: cpuPattern[cpuPattern.length-1] },
    memory: { avg: memAvg, max: Math.max(...memPattern), min: Math.min(...memPattern), p50: memAvg, p95: Math.max(...memPattern)*0.95, p99: Math.max(...memPattern)*0.99, latest: memPattern[memPattern.length-1], total_mb: 7168, swap_max_mb: 0 },
    load: { avg_1m: 1.5, max_1m: 3.2 },
    top_processes: [{ pid: 100, name: 'node', cpu_pct: 35, mem_mb: 256 }],
    timeline: { cpu_pct: cpuPattern, mem_mb: memPattern },
    steps: name === 'build' ? [
      { name: 'Checkout', number: 1, duration_seconds: 8, cpu_avg: 15, cpu_max: 30, mem_avg_mb: 800, mem_max_mb: 1000, sample_count: 3 },
      { name: 'Setup Node.js', number: 2, duration_seconds: 15, cpu_avg: 20, cpu_max: 40, mem_avg_mb: 900, mem_max_mb: 1100, sample_count: 5 },
      { name: 'Install deps', number: 3, duration_seconds: 52, cpu_avg: 45, cpu_max: 70, mem_avg_mb: 1800, mem_max_mb: 2500, sample_count: 17 },
      { name: 'Build', number: 4, duration_seconds: 205, cpu_avg: 72, cpu_max: 97, mem_avg_mb: 3200, mem_max_mb: 4800, sample_count: 68 },
    ] : name === 'lint' ? [
      { name: 'Checkout', number: 1, duration_seconds: 6, cpu_avg: 12, cpu_max: 25, mem_avg_mb: 700, mem_max_mb: 900, sample_count: 2 },
      { name: 'Setup Node.js', number: 2, duration_seconds: 12, cpu_avg: 18, cpu_max: 35, mem_avg_mb: 850, mem_max_mb: 1050, sample_count: 4 },
      { name: 'Lint', number: 3, duration_seconds: 77, cpu_avg: 55, cpu_max: 78, mem_avg_mb: 2200, mem_max_mb: 3100, sample_count: 26 },
    ] : [
      { name: 'Checkout', number: 1, duration_seconds: 7, cpu_avg: 14, cpu_max: 28, mem_avg_mb: 750, mem_max_mb: 950, sample_count: 2 },
      { name: 'Setup Node.js', number: 2, duration_seconds: 14, cpu_avg: 19, cpu_max: 38, mem_avg_mb: 880, mem_max_mb: 1080, sample_count: 5 },
      { name: 'Install deps', number: 3, duration_seconds: 48, cpu_avg: 40, cpu_max: 65, mem_avg_mb: 1700, mem_max_mb: 2400, sample_count: 16 },
      { name: 'Run tests', number: 4, duration_seconds: 141, cpu_avg: 68, cpu_max: 95, mem_avg_mb: 3500, mem_max_mb: 4900, sample_count: 47 },
    ],
  };
}

// Generate realistic CPU/memory patterns
function cpuBuild(): number[] {
  const v: number[] = [];
  // Checkout + setup: low CPU
  for (let i = 0; i < 8; i++) v.push(15 + Math.random() * 20);
  // Install deps: medium CPU with spikes
  for (let i = 0; i < 17; i++) v.push(30 + Math.random() * 30);
  // Build: high CPU
  for (let i = 0; i < 55; i++) v.push(55 + Math.random() * 42);
  return v;
}
function memBuild(): number[] {
  const v: number[] = [];
  for (let i = 0; i < 8; i++) v.push(800 + i * 50);
  for (let i = 0; i < 17; i++) v.push(1200 + i * 80);
  for (let i = 0; i < 55; i++) v.push(2500 + i * 40);
  return v;
}
function cpuLint(): number[] {
  const v: number[] = [];
  for (let i = 0; i < 6; i++) v.push(10 + Math.random() * 15);
  for (let i = 0; i < 30; i++) v.push(35 + Math.random() * 45);
  return v;
}
function memLint(): number[] {
  const v: number[] = [];
  for (let i = 0; i < 6; i++) v.push(700 + i * 40);
  for (let i = 0; i < 30; i++) v.push(1000 + i * 70);
  return v;
}
function cpuTest(): number[] {
  const v: number[] = [];
  for (let i = 0; i < 7; i++) v.push(12 + Math.random() * 18);
  for (let i = 0; i < 16; i++) v.push(25 + Math.random() * 25);
  for (let i = 0; i < 47; i++) v.push(50 + Math.random() * 48);
  return v;
}
function memTest(): number[] {
  const v: number[] = [];
  for (let i = 0; i < 7; i++) v.push(750 + i * 45);
  for (let i = 0; i < 16; i++) v.push(1100 + i * 75);
  for (let i = 0; i < 47; i++) v.push(2400 + i * 55);
  return v;
}

const jobs: JobReport[] = [
  { jobName: 'build', report: makeReport('build', 0, 280, cpuBuild(), memBuild()) },
  { jobName: 'lint', report: makeReport('lint', 4, 95, cpuLint(), memLint()) },
  { jobName: 'test', report: makeReport('test', 6, 210, cpuTest(), memTest()) },
];

const md = workflowMarkdown(jobs, makeConfig());

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="dark">
  <title>RunnerLens — Workflow Summary Preview</title>
  <style>
    body {
      background: #0d1117;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      max-width: 720px;
      margin: 40px auto;
      padding: 0 20px;
      line-height: 1.6;
    }
    h2, h3 { border-bottom: 1px solid #21262d; padding-bottom: 8px; }
    a { color: #58a6ff; }
    sub { color: #8b949e; }
    svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${md}
</body>
</html>`;

require('fs').writeFileSync('/mnt/user-data/outputs/preview-workflow-summary.html', html);
console.log('Preview written!');
