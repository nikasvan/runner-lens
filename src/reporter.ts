import type {
  MetricSample, SystemInfo, MonitorConfig,
  AggregatedReport, ProcessInfo,
} from './types';
import { stats, safeMax, safePct } from './stats';
import { evaluateAlerts } from './alerts';
import { recommend } from './recommendations';
import { sparkline, intensityBar, fmtBytes, fmtDuration } from './charts';
import { REPORT_VERSION } from './constants';

// ─────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────

function aggregate(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  config: MonitorConfig,
  durationSec: number,
): AggregatedReport {
  const cpuStats = stats(samples.map((s) => s.cpu.usage));
  const memStats = stats(samples.map((s) => s.memory.used_mb));
  const memTotal = samples[0]?.memory.total_mb ?? 0;
  const swapMax  = safeMax(samples.map((s) => s.memory.swap_used_mb));

  const totalDiskR  = samples.reduce((a, s) => a + (s.disk_io?.read_bytes  ?? 0), 0);
  const totalDiskW  = samples.reduce((a, s) => a + (s.disk_io?.write_bytes ?? 0), 0);
  const totalNetRx  = samples.reduce((a, s) => a + (s.network?.rx_bytes ?? 0), 0);
  const totalNetTx  = samples.reduce((a, s) => a + (s.network?.tx_bytes ?? 0), 0);

  const MB = 1024 * 1024;
  const d  = durationSec || 1;

  const loadVals = samples.map((s) => s.load?.load1 ?? 0);
  const loadAvg  = loadVals.length > 0
    ? loadVals.reduce((a, b) => a + b, 0) / loadVals.length
    : 0;

  // Top processes: keep highest-CPU snapshot per unique name
  const procMap = new Map<string, ProcessInfo>();
  for (const s of samples) {
    for (const p of s.processes ?? []) {
      const cur = procMap.get(p.name);
      if (!cur || p.cpu_pct > cur.cpu_pct) procMap.set(p.name, p);
    }
  }
  const topProcs = [...procMap.values()].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 10);

  const last = samples[samples.length - 1];
  const diskSpace = (last?.disk_space ?? []).map((ds) => ({
    mount: ds.mount, usage_pct: ds.usage_pct, available_mb: ds.available_mb,
  }));

  const alerts = evaluateAlerts(samples, config, cpuStats, memStats, memTotal);

  const report: AggregatedReport = {
    version: REPORT_VERSION,
    system: sysInfo,
    duration_seconds: durationSec,
    sample_count: samples.length,
    started_at: new Date(samples[0].timestamp * 1000).toISOString(),
    ended_at:   new Date(last.timestamp * 1000).toISOString(),
    cpu: cpuStats,
    memory: { ...memStats, total_mb: memTotal, swap_max_mb: swapMax },
    disk_io: {
      total_read_mb:  totalDiskR / MB,
      total_write_mb: totalDiskW / MB,
      avg_read_mbps:  totalDiskR / MB / d,
      avg_write_mbps: totalDiskW / MB / d,
    },
    network: {
      total_rx_mb:  totalNetRx / MB,
      total_tx_mb:  totalNetTx / MB,
      avg_rx_mbps:  totalNetRx / MB / d,
      avg_tx_mbps:  totalNetTx / MB / d,
    },
    disk_space: diskSpace,
    load: {
      avg_1m: loadAvg,
      max_1m: safeMax(loadVals),
    },
    top_processes: topProcs,
    alerts,
    recommendations: [],
  };

  report.recommendations = recommend(report, samples);
  return report;
}

// ─────────────────────────────────────────────────────────────
// Markdown generation
// ─────────────────────────────────────────────────────────────

function icon(level: string): string {
  if (level === 'critical') return '🔴';
  if (level === 'warning')  return '🟡';
  return '🔵';
}

function badge(report: AggregatedReport): string {
  if (report.alerts.some((a) => a.level === 'critical')) return '🔴 Critical';
  if (report.alerts.some((a) => a.level === 'warning'))  return '🟡 Warning';
  return '🟢 Healthy';
}

function markdown(
  report: AggregatedReport,
  samples: MetricSample[],
  config: MonitorConfig,
): string {
  const full    = config.summaryStyle === 'full';
  const compact = config.summaryStyle === 'compact';
  const o       = full ? ' open' : '';
  const L: string[] = [];

  // Header
  L.push('## 📊 RunnerLens — Resource Report\n');
  L.push(
    `**${badge(report)}** &nbsp;|&nbsp; ` +
    `**Duration:** ${fmtDuration(report.duration_seconds)} &nbsp;|&nbsp; ` +
    `**Samples:** ${report.sample_count}\n`,
  );

  // Alerts
  if (report.alerts.length) {
    L.push(`<details open><summary><strong>⚠️ Alerts (${report.alerts.length})</strong></summary>\n`);
    for (const a of report.alerts) L.push(`${icon(a.level)} **${a.metric}:** ${a.message}  `);
    L.push('\n</details>\n');
  }

  // System
  L.push(`<details${o}><summary><strong>🖥️ Runner</strong></summary>\n`);
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| **CPUs** | ${report.system.cpu_count} × ${report.system.cpu_model} |`);
  L.push(`| **RAM** | ${report.system.total_memory_mb.toLocaleString()} MB |`);
  L.push(`| **OS** | ${report.system.os_release} |`);
  L.push(`| **Kernel** | ${report.system.kernel} |`);
  L.push(`| **Runner** | ${report.system.runner_name} (${report.system.runner_os}/${report.system.runner_arch}) |`);
  L.push('\n</details>\n');

  // CPU
  const cpuV = samples.map((s) => s.cpu.usage);
  L.push(`<details${full || compact ? ' open' : ''}><summary><strong>🔥 CPU</strong></summary>\n`);
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Average | **${report.cpu.avg.toFixed(1)} %** |`);
  L.push(`| Peak | ${report.cpu.max.toFixed(1)} % |`);
  L.push(`| p95 | ${report.cpu.p95.toFixed(1)} % |`);
  L.push(`| p99 | ${report.cpu.p99.toFixed(1)} % |`);
  if (full && cpuV.length >= 4) {
    L.push('');
    L.push('```');
    L.push(`  CPU %  ${sparkline(cpuV, 52)}`);
    L.push(`         ${intensityBar(cpuV, 52)}`);
    L.push('```');
  }
  L.push('\n</details>\n');

  // Memory
  const memPct = samples.map((s) => s.memory.usage_pct);
  L.push(`<details${full || compact ? ' open' : ''}><summary><strong>🧠 Memory</strong></summary>\n`);
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Total | ${report.memory.total_mb.toLocaleString()} MB |`);
  L.push(`| Avg used | **${report.memory.avg.toFixed(0)} MB** (${safePct(report.memory.avg, report.memory.total_mb).toFixed(1)} %) |`);
  L.push(`| Peak used | ${report.memory.max.toFixed(0)} MB (${safePct(report.memory.max, report.memory.total_mb).toFixed(1)} %) |`);
  L.push(`| p95 | ${report.memory.p95.toFixed(0)} MB |`);
  if (report.memory.swap_max_mb > 0) {
    L.push(`| Swap peak | ⚠️ ${report.memory.swap_max_mb} MB |`);
  }
  if (full && memPct.length >= 4) {
    L.push('');
    L.push('```');
    L.push(`  MEM %  ${sparkline(memPct, 52)}`);
    L.push(`         ${intensityBar(memPct, 52)}`);
    L.push('```');
  }
  L.push('\n</details>\n');

  // Disk I/O
  if (config.includeDisk) {
    L.push(`<details${o}><summary><strong>💾 Disk</strong></summary>\n`);
    L.push('| Metric | Value |');
    L.push('|---|---|');
    L.push(`| Read | ${fmtBytes(report.disk_io.total_read_mb * 1024 * 1024)} (${report.disk_io.avg_read_mbps.toFixed(1)} MB/s avg) |`);
    L.push(`| Written | ${fmtBytes(report.disk_io.total_write_mb * 1024 * 1024)} (${report.disk_io.avg_write_mbps.toFixed(1)} MB/s avg) |`);
    if (report.disk_space.length) {
      L.push('');
      L.push('| Mount | Usage | Free |');
      L.push('|---|---|---|');
      for (const d of report.disk_space)
        L.push(`| \`${d.mount}\` | ${d.usage_pct} % | ${fmtBytes(d.available_mb * 1024 * 1024)} |`);
    }
    L.push('\n</details>\n');
  }

  // Network
  if (config.includeNetwork) {
    L.push(`<details${o}><summary><strong>🌐 Network</strong></summary>\n`);
    L.push('| Metric | Value |');
    L.push('|---|---|');
    L.push(`| Received | ${fmtBytes(report.network.total_rx_mb * 1024 * 1024)} (${report.network.avg_rx_mbps.toFixed(2)} MB/s avg) |`);
    L.push(`| Sent | ${fmtBytes(report.network.total_tx_mb * 1024 * 1024)} (${report.network.avg_tx_mbps.toFixed(2)} MB/s avg) |`);
    L.push('\n</details>\n');
  }

  // Top processes
  if (config.includeProcesses && report.top_processes.length) {
    L.push(`<details${o}><summary><strong>🔄 Top Processes (peak CPU)</strong></summary>\n`);
    L.push('| Process | CPU | Memory |');
    L.push('|---|---|---|');
    for (const p of report.top_processes.slice(0, 8))
      L.push(`| \`${p.name}\` | ${p.cpu_pct.toFixed(1)} % | ${p.mem_mb.toFixed(0)} MB |`);
    L.push('\n</details>\n');
  }

  // Recommendations
  if (report.recommendations.length) {
    L.push('<details open><summary><strong>💡 Recommendations</strong></summary>\n');
    for (const rec of report.recommendations) L.push(`- ${rec}`);
    L.push('\n</details>\n');
  }

  // Footer
  L.push('---');
  L.push(
    `<sub>Generated by <a href="https://runnerlens.com">RunnerLens</a> ` +
    `v${REPORT_VERSION} · ${report.started_at} → ${report.ended_at}</sub>`,
  );

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export function processMetrics(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  config: MonitorConfig,
  durationSec: number,
): { report: AggregatedReport; markdown: string } {
  const report = aggregate(samples, sysInfo, config, durationSec);
  const md = config.summaryStyle === 'none' ? '' : markdown(report, samples, config);
  return { report, markdown: md };
}
