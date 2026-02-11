import * as core from '@actions/core';
import * as https from 'https';
import type { MetricSample, StepMetrics } from './types';

// ─────────────────────────────────────────────────────────────
// Types for GitHub API response
// ─────────────────────────────────────────────────────────────

interface GitHubStep {
  name: string;
  number: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

interface GitHubJob {
  name: string;
  status: string;
  steps: GitHubStep[];
}

// ─────────────────────────────────────────────────────────────
// Fetch steps from GitHub API
// ─────────────────────────────────────────────────────────────

function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...headers, 'User-Agent': 'RunnerLens' },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export async function fetchSteps(token: string): Promise<GitHubStep[]> {
  const repo  = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const job   = process.env.GITHUB_JOB;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';

  if (!repo || !runId || !job) {
    core.debug('RunnerLens: missing GITHUB env vars for step detection');
    return [];
  }

  const url = `${apiUrl}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`;
  const res = await httpGet(url, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  if (res.status !== 200) {
    core.debug(`RunnerLens: GitHub API returned ${res.status}`);
    return [];
  }

  const data = JSON.parse(res.body);
  const jobs: GitHubJob[] = data.jobs ?? [];

  // Find current job: try exact key match, then display-name match,
  // then fall back to the in-progress job (handles custom `name:` on jobs).
  const current =
    jobs.find((j) => j.name === job) ??
    jobs.find((j) => j.status === 'in_progress');
  if (!current) {
    core.debug(`RunnerLens: could not find job "${job}" in API response`);
    return [];
  }

  return current.steps ?? [];
}

// ─────────────────────────────────────────────────────────────
// Correlate steps with samples
// ─────────────────────────────────────────────────────────────

export function correlateSteps(
  steps: GitHubStep[],
  samples: MetricSample[],
): StepMetrics[] {
  if (steps.length === 0 || samples.length === 0) return [];

  const nowSec = Math.floor(Date.now() / 1000);

  return steps
    .filter((s) => s.started_at)
    .map((step) => {
      const startSec = Math.floor(new Date(step.started_at!).getTime() / 1000);
      const endSec = step.completed_at
        ? Math.floor(new Date(step.completed_at).getTime() / 1000)
        : nowSec;

      const window = samples.filter(
        (s) => s.timestamp >= startSec && s.timestamp <= endSec,
      );

      const duration = Math.max(0, endSec - startSec);

      if (window.length === 0) {
        return {
          name: step.name,
          number: step.number,
          duration_seconds: duration,
          cpu_avg: 0,
          cpu_max: 0,
          mem_avg_mb: 0,
          mem_max_mb: 0,
          sample_count: 0,
        };
      }

      const cpuVals = window.map((s) => s.cpu.usage);
      const memVals = window.map((s) => s.memory.used_mb);

      return {
        name: step.name,
        number: step.number,
        duration_seconds: duration,
        cpu_avg: cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length,
        cpu_max: Math.max(...cpuVals),
        mem_avg_mb: memVals.reduce((a, b) => a + b, 0) / memVals.length,
        mem_max_mb: Math.max(...memVals),
        sample_count: window.length,
      };
    });
}
