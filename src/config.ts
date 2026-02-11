import * as core from '@actions/core';
import type { MonitorConfig } from './types';

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function intInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseConfig(): MonitorConfig {
  const apiKey = core.getInput('api-key');
  if (apiKey) core.setSecret(apiKey);

  const style = core.getInput('summary-style') || 'full';
  const validStyles = ['full', 'compact', 'minimal', 'none'] as const;
  const summaryStyle = validStyles.includes(style as typeof validStyles[number])
    ? (style as MonitorConfig['summaryStyle'])
    : 'full';

  return {
    sampleInterval: clamp(intInput('sample-interval', 3), 1, 30),
    includeProcesses: core.getInput('include-processes') !== 'false',
    summaryStyle,
    maxSizeMb: Math.max(0, intInput('max-file-size', 100)),
    apiKey,
    apiEndpoint: core.getInput('api-endpoint') || 'https://api.runnerlens.com',
    thresholds: {
      cpu_warn: clamp(intInput('threshold-cpu-warn', 80), 1, 100),
      cpu_crit: clamp(intInput('threshold-cpu-crit', 95), 1, 100),
      mem_warn: clamp(intInput('threshold-mem-warn', 80), 1, 100),
      mem_crit: clamp(intInput('threshold-mem-crit', 95), 1, 100),
    },
  };
}
