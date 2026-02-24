// ─────────────────────────────────────────────────────────────
// RunnerLens — Workflow-Level Summary (deprecated)
// ─────────────────────────────────────────────────────────────

import * as core from '@actions/core';
import type { MonitorConfig } from './types';

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function runSummary(_config: MonitorConfig): Promise<void> {
  core.warning(
    'RunnerLens: summarize mode is deprecated and no longer functional. ' +
    'Chart generation and artifact aggregation have been removed.',
  );
}
