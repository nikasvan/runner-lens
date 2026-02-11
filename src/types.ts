// ─────────────────────────────────────────────────────────────
// RunnerLens — Type Definitions
// ─────────────────────────────────────────────────────────────

export interface CpuSample {
  user: number;
  system: number;
  idle: number;
  iowait: number;
  steal: number;
  usage: number;
}

export interface MemorySample {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  cached_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
  usage_pct: number;
}

export interface DiskIoSample {
  read_bytes: number;
  write_bytes: number;
  read_ops: number;
  write_ops: number;
}

export interface DiskSpaceSample {
  mount: string;
  total_mb: number;
  used_mb: number;
  available_mb: number;
  usage_pct: number;
}

export interface NetworkSample {
  rx_bytes: number;
  tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_pct: number;
  mem_mb: number;
}

export interface LoadAverage {
  load1: number;
  load5: number;
  load15: number;
}

export interface MetricSample {
  timestamp: number;
  cpu: CpuSample;
  memory: MemorySample;
  disk_io: DiskIoSample;
  disk_space: DiskSpaceSample[];
  network: NetworkSample;
  load: LoadAverage;
  processes: ProcessInfo[];
}

export interface SystemInfo {
  cpu_count: number;
  cpu_model: string;
  total_memory_mb: number;
  os_release: string;
  kernel: string;
  runner_name: string;
  runner_os: string;
  runner_arch: string;
}

export interface ThresholdConfig {
  cpu_warn: number;
  cpu_crit: number;
  mem_warn: number;
  mem_crit: number;
}

export interface MonitorConfig {
  sampleInterval: number;
  includeProcesses: boolean;
  includeNetwork: boolean;
  includeDisk: boolean;
  summaryStyle: 'full' | 'compact' | 'minimal' | 'none';
  maxSizeMb: number;
  apiKey: string;
  apiEndpoint: string;
  thresholds: ThresholdConfig;
}

export interface MetricStats {
  avg: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  latest: number;
}

export interface Alert {
  level: 'info' | 'warning' | 'critical';
  metric: string;
  message: string;
  value: number;
  threshold: number;
}

export interface AggregatedReport {
  version: string;
  system: SystemInfo;
  duration_seconds: number;
  sample_count: number;
  started_at: string;
  ended_at: string;

  cpu: MetricStats;
  memory: MetricStats & { total_mb: number; swap_max_mb: number };

  disk_io: {
    total_read_mb: number;
    total_write_mb: number;
    avg_read_mbps: number;
    avg_write_mbps: number;
  };

  network: {
    total_rx_mb: number;
    total_tx_mb: number;
    avg_rx_mbps: number;
    avg_tx_mbps: number;
  };

  disk_space: { mount: string; usage_pct: number; available_mb: number }[];
  load: { avg_1m: number; max_1m: number };
  top_processes: ProcessInfo[];
  alerts: Alert[];
  recommendations: string[];
}

export interface IngestPayload {
  version: string;
  run_id: string;
  run_number: number;
  workflow: string;
  job: string;
  repository: string;
  ref: string;
  sha: string;
  actor: string;
  event_name: string;
  report: AggregatedReport;
  samples?: MetricSample[];
}
