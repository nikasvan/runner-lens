// Preview generator — run with: npm run preview

jest.mock('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { workflowMarkdown } from '../src/summary';
import type { MonitorConfig, AggregatedReport, JobReport } from '../src/types';

function makeConfig(): MonitorConfig {
  return {
    mode: 'summarize',
    sampleInterval: 3,

    summaryStyle: 'full',
    maxSizeMb: 100,
    apiKey: '',
    apiEndpoint: 'https://api.runnerlens.com',
    githubToken: '',
  };
}

function makeJob(name: string, started: string, duration: number, overrides: Partial<AggregatedReport> = {}): JobReport {
  const n = 80;
  return {
    jobName: name,
    report: {
      version: '1.0.0',
      system: {
        cpu_count: 2,
        cpu_model: 'AMD EPYC 7763',
        total_memory_mb: 7168,
        os_release: 'Ubuntu 22.04.3 LTS',
        kernel: '6.2.0-1018-azure',
        runner_name: 'GitHub Actions 4',
        runner_os: 'Linux',
        runner_arch: 'X64',
      },
      duration_seconds: duration,
      sample_count: n,
      started_at: started,
      ended_at: new Date(new Date(started).getTime() + duration * 1000).toISOString(),
      cpu: { avg: 55, max: 93, min: 8, p50: 52, p95: 88, p99: 92, latest: 60 },
      memory: { avg: 3200, max: 5400, min: 1100, p50: 3100, p95: 5000, p99: 5300, latest: 3500, total_mb: 7168, swap_max_mb: 0 },
      load: { avg_1m: 1.8, max_1m: 3.5 },
      top_processes: [{ pid: 100, name: 'node', cpu_pct: 42, mem_mb: 320 }],
      timeline: {
        cpu_pct: Array.from({ length: n }, (_, i) => {
          const base = 20 + Math.sin(i / 8) * 30 + i * 0.5;
          return Math.min(100, Math.max(0, Math.round(base)));
        }),
        mem_mb: Array.from({ length: n }, (_, i) => {
          const base = 1500 + i * 40 + Math.sin(i / 6) * 500;
          return Math.min(7168, Math.max(0, Math.round(base)));
        }),
      },
      ...overrides,
    },
  };
}

test('generate preview HTML', () => {
  const jobs: JobReport[] = [
    makeJob('build', '2023-11-14T22:00:00Z', 280, {
      cpu: { avg: 62, max: 95, min: 12, p50: 60, p95: 90, p99: 94, latest: 55 },
      memory: { avg: 3400, max: 5800, min: 1200, p50: 3300, p95: 5500, p99: 5700, latest: 3600, total_mb: 7168, swap_max_mb: 0 },
      steps: [
        { name: 'Checkout', number: 1, duration_seconds: 8, cpu_avg: 12, cpu_max: 35, mem_avg_mb: 1400, mem_max_mb: 1800, sample_count: 3 },
        { name: 'Setup Node.js', number: 2, duration_seconds: 15, cpu_avg: 28, cpu_max: 55, mem_avg_mb: 1800, mem_max_mb: 2200, sample_count: 5 },
        { name: 'Install deps', number: 3, duration_seconds: 52, cpu_avg: 68, cpu_max: 92, mem_avg_mb: 3200, mem_max_mb: 4500, sample_count: 17 },
        { name: 'Build', number: 4, duration_seconds: 205, cpu_avg: 78, cpu_max: 95, mem_avg_mb: 4700, mem_max_mb: 5800, sample_count: 68 },
      ],
    }),
    makeJob('lint', '2023-11-14T22:05:00Z', 95, {
      cpu: { avg: 45, max: 78, min: 10, p50: 43, p95: 72, p99: 76, latest: 40 },
      memory: { avg: 2800, max: 4100, min: 900, p50: 2700, p95: 3800, p99: 4000, latest: 2900, total_mb: 7168, swap_max_mb: 0 },
      steps: [
        { name: 'Checkout', number: 1, duration_seconds: 6, cpu_avg: 10, cpu_max: 30, mem_avg_mb: 1200, mem_max_mb: 1500, sample_count: 2 },
        { name: 'Setup Node.js', number: 2, duration_seconds: 12, cpu_avg: 22, cpu_max: 48, mem_avg_mb: 1600, mem_max_mb: 2000, sample_count: 4 },
        { name: 'Lint', number: 3, duration_seconds: 77, cpu_avg: 52, cpu_max: 78, mem_avg_mb: 3200, mem_max_mb: 4100, sample_count: 26 },
      ],
    }),
    makeJob('test', '2023-11-14T22:06:30Z', 210, {
      cpu: { avg: 72, max: 97, min: 15, p50: 70, p95: 94, p99: 96, latest: 68 },
      memory: { avg: 3600, max: 6100, min: 1300, p50: 3500, p95: 5800, p99: 6000, latest: 3800, total_mb: 7168, swap_max_mb: 0 },
      steps: [
        { name: 'Checkout', number: 1, duration_seconds: 7, cpu_avg: 11, cpu_max: 32, mem_avg_mb: 1300, mem_max_mb: 1600, sample_count: 2 },
        { name: 'Setup Node.js', number: 2, duration_seconds: 14, cpu_avg: 25, cpu_max: 50, mem_avg_mb: 1700, mem_max_mb: 2100, sample_count: 5 },
        { name: 'Install deps', number: 3, duration_seconds: 48, cpu_avg: 60, cpu_max: 88, mem_avg_mb: 3000, mem_max_mb: 4200, sample_count: 16 },
        { name: 'Run tests', number: 4, duration_seconds: 141, cpu_avg: 88, cpu_max: 97, mem_avg_mb: 4800, mem_max_mb: 6100, sample_count: 47 },
      ],
    }),
  ];

  const md = workflowMarkdown(jobs, makeConfig());

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="dark">
  <title>RunnerLens Preview — v2 Charts</title>
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
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
    th, td { border: 1px solid #30363d; padding: 8px 12px; text-align: left; }
    th { background: #161b22; color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { font-variant-numeric: tabular-nums; }
    tr:hover td { background: #161b22; }
    td:nth-child(n+3) { text-align: right; }
    a { color: #58a6ff; }
    details { margin: 8px 0; }
    summary { cursor: pointer; }
    sub { color: #8b949e; }
    img { max-width: 100%; height: auto; }
    strong { color: #e6edf3; }
    p { margin: 8px 0; }
  </style>
</head>
<body>
${(() => {
  const lines = md.split('\n');
  const out: string[] = [];
  let inTable = false;
  let headerDone = false;

  for (const l of lines) {
    // Markdown table row
    if (l.startsWith('|')) {
      const cells = l.split('|').slice(1, -1).map(c => c.trim());
      // Separator row (|---|---|...)
      if (cells.every(c => /^[-:]+$/.test(c))) {
        continue; // skip separator, we already emitted <thead>
      }
      if (!inTable) {
        out.push('<table>');
        inTable = true;
        headerDone = false;
      }
      if (!headerDone) {
        out.push('<thead><tr>' + cells.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>');
        headerDone = true;
      } else {
        out.push('<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>');
      }
      continue;
    }
    // Close table if we were in one
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
      headerDone = false;
    }
    // Headings
    if (/^#{2,3} /.test(l)) {
      const level = l.startsWith('###') ? 'h3' : 'h2';
      out.push('<' + level + '>' + l.replace(/^#{2,3} /, '') + '</' + level + '>');
      continue;
    }
    // Already HTML
    if (l.startsWith('<')) { out.push(l); continue; }
    // Blank
    if (l.trim() === '') { out.push(''); continue; }
    // Inline markdown bold
    const rendered = l.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                      .replace(/`([^`]+)`/g, '<code>$1</code>');
    out.push('<p>' + rendered + '</p>');
  }
  if (inTable) out.push('</tbody></table>');
  return out.join('\n');
})()}
</body>
</html>`;

  const outPath = path.join(__dirname, '..', 'preview-summary.html');
  fs.writeFileSync(outPath, html);

  // Also extract SVGs for standalone viewing
  const svgMatches = md.matchAll(/data:image\/svg\+xml,([^"]+)/g);
  let idx = 0;
  const names = ['stats', 'cpu-chart', 'mem-chart', 'waterfall'];
  for (const m of svgMatches) {
    const svg = decodeURIComponent(m[1]);
    const name = names[idx] || `chart-${idx}`;
    fs.writeFileSync(path.join(__dirname, '..', `preview-${name}.svg`), svg);
    idx++;
  }

  expect(md).toContain('Workflow Summary');
});
