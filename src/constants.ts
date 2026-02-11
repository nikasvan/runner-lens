import * as path from 'path';
import * as os from 'os';

/** All RunnerLens temp files live here; cleaned up in the post step. */
export const DATA_DIR = path.join(os.tmpdir(), 'runnerlens');

export const METRICS_FILE = path.join(DATA_DIR, 'metrics.jsonl');
export const PID_FILE = path.join(DATA_DIR, 'collector.pid');
export const SYSINFO_FILE = path.join(DATA_DIR, 'sysinfo.json');
export const START_TS_FILE = path.join(DATA_DIR, 'start_ts');

/** State keys shared between main → post. */
export const STATE = {
  ACTIVE: 'runnerlens-active',
  DATA_DIR: 'runnerlens-data-dir',
  PID: 'runnerlens-pid',
} as const;

export const REPORT_VERSION = '1.0.0';
