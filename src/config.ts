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
  // Auto-detect: explicit input → GITHUB_TOKEN env → ACTIONS_RUNTIME_TOKEN env
  const githubToken = core.getInput('github-token')
    || process.env.GITHUB_TOKEN
    || process.env.ACTIONS_RUNTIME_TOKEN
    || '';

  const modeRaw = core.getInput('mode') || 'monitor';
  const mode = (modeRaw === 'summarize' ? 'summarize' : 'monitor') as MonitorConfig['mode'];

  return {
    mode,
    sampleInterval: clamp(intInput('sample-interval', 3), 1, 30),
    maxSizeMb: Math.max(0, intInput('max-file-size', 100)),
    githubToken,
  };
}
