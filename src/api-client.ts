import * as core from '@actions/core';
import * as https from 'https';
import * as zlib from 'zlib';
import type { MonitorConfig, AggregatedReport, MetricSample, IngestPayload } from './types';
import { REPORT_VERSION } from './constants';

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB hard limit
const TIMEOUT_MS = 15_000;

function gzipAsync(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf, { level: 6 }, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

function httpPost(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': body.length.toString(),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function buildPayload(
  report: AggregatedReport,
  samples: MetricSample[] | undefined,
): IngestPayload {
  return {
    version: REPORT_VERSION,
    run_id: process.env.GITHUB_RUN_ID ?? '',
    run_number: parseInt(process.env.GITHUB_RUN_NUMBER ?? '0', 10),
    workflow: process.env.GITHUB_WORKFLOW ?? '',
    job: process.env.GITHUB_JOB ?? '',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    ref: process.env.GITHUB_REF ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    actor: process.env.GITHUB_ACTOR ?? '',
    event_name: process.env.GITHUB_EVENT_NAME ?? '',
    report,
    ...(samples ? { samples } : {}),
  };
}

export async function sendToApi(
  config: MonitorConfig,
  report: AggregatedReport,
  samples: MetricSample[],
): Promise<void> {
  // Try full payload first; if too large, retry without raw samples
  let raw = Buffer.from(JSON.stringify(buildPayload(report, samples)), 'utf-8');

  if (raw.length > MAX_PAYLOAD_BYTES) {
    core.info('RunnerLens: payload too large, sending report only (no raw samples)');
    raw = Buffer.from(JSON.stringify(buildPayload(report, undefined)), 'utf-8');
  }

  const compressed = await gzipAsync(raw);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Encoding': 'gzip',
    'Authorization': `Bearer ${config.apiKey}`,
    'User-Agent': `RunnerLens/${REPORT_VERSION}`,
  };

  const url = `${config.apiEndpoint.replace(/\/+$/, '')}/v1/ingest`;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await httpPost(url, compressed, headers);

      if (res.status >= 200 && res.status < 300) {
        try {
          const body = JSON.parse(res.body);
          if (body.dashboard_url) {
            core.info(`RunnerLens: dashboard → ${body.dashboard_url}`);
          }
        } catch { /* non-JSON response is fine */ }
        core.info('RunnerLens: metrics sent to dashboard');
        return;
      }

      if (res.status === 401 || res.status === 403) {
        core.warning('RunnerLens: invalid API key — skipping upload');
        return;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          const delay = 1000 * 2 ** attempt; // exponential: 1s, 2s
          core.debug(`RunnerLens: ${res.status}, retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      core.warning(`RunnerLens: API returned ${res.status} — ${res.body.slice(0, 200)}`);
      return;

    } catch (err) {
      if (attempt < maxRetries) {
        const delay = 1000 * 2 ** attempt;
        core.debug(`RunnerLens: request failed, retrying in ${delay}ms — ${err}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      core.warning(`RunnerLens: could not reach API — ${err}`);
    }
  }
}
