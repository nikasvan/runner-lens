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

export interface CollectorSample {
  cpu_pct: number;
  mem_mb: number;
}

export interface MetricSample {
  timestamp: number;
  cpu: CpuSample;
  memory: MemorySample;
  load: LoadAverage;
  processes: ProcessInfo[];
  collector?: CollectorSample;
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

export interface MonitorConfig {
  mode: 'monitor' | 'summarize';
  sampleInterval: number;
  maxSizeMb: number;
  githubToken: string;
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

export interface StepMetrics {
  name: string;
  number: number;
  duration_seconds: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg_mb: number;
  mem_max_mb: number;
  sample_count: number;
  started_at: string;
  completed_at: string;
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

  load: { avg_1m: number; max_1m: number };
  top_processes: ProcessInfo[];
  steps?: StepMetrics[];
  timeline?: {
    cpu_pct: number[];   // downsampled CPU usage %, 0-100
    mem_mb: number[];    // downsampled memory usage in MB
  };
  collector?: { avg_cpu_pct: number; avg_mem_mb: number; max_mem_mb: number };
  reporter?: { cpu_pct: number; mem_mb: number };
}

export interface JobReport {
  jobName: string;
  report: AggregatedReport;
}

