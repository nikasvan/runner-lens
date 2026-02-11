import type {
  MetricSample, SystemInfo, MonitorConfig,
  AggregatedReport, ProcessInfo, StepMetrics,
} from './types';
import { stats, safeMax, safePct } from './stats';
import { evaluateAlerts } from './alerts';
import { recommend } from './recommendations';
import { sparkline, progressBar, statusDot, fmtDuration } from './charts';
import { REPORT_VERSION } from './constants';

// ─────────────────────────────────────────────────────────────
// Aggregation (unchanged)
// ─────────────────────────────────────────────────────────────

function aggregate(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  config: MonitorConfig,
  durationSec: number,
  steps?: StepMetrics[],
): AggregatedReport {
  const cpuStats = stats(samples.map((s) => s.cpu.usage));
  const memStats = stats(samples.map((s) => s.memory.used_mb));
  const memTotal = samples[0]?.memory.total_mb ?? 0;
  const swapMax  = safeMax(samples.map((s) => s.memory.swap_used_mb));

  const loadVals = samples.map((s) => s.load?.load1 ?? 0);
  const loadAvg  = loadVals.length > 0
    ? loadVals.reduce((a, b) => a + b, 0) / loadVals.length
    : 0;

  const procMap = new Map<string, ProcessInfo>();
  for (const s of samples) {
    for (const p of s.processes ?? []) {
      const cur = procMap.get(p.name);
      if (!cur || p.cpu_pct > cur.cpu_pct) procMap.set(p.name, p);
    }
  }
  const topProcs = [...procMap.values()].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 10);

  const last = samples[samples.length - 1];

  // ── Collector self-monitoring stats ─────────────────────
  const collSamples = samples.filter((s) => s.collector);
  let collector: AggregatedReport['collector'];
  if (collSamples.length > 0) {
    const cpuVals = collSamples.map((s) => s.collector!.cpu_pct);
    const memVals = collSamples.map((s) => s.collector!.mem_mb);
    collector = {
      avg_cpu_pct: cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length,
      avg_mem_mb: memVals.reduce((a, b) => a + b, 0) / memVals.length,
      max_mem_mb: safeMax(memVals),
    };
  }

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
    load: {
      avg_1m: loadAvg,
      max_1m: safeMax(loadVals),
    },
    top_processes: topProcs,
    alerts,
    recommendations: [],
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(collector ? { collector } : {}),
  };

  report.recommendations = recommend(report, samples);
  return report;
}

// ─────────────────────────────────────────────────────────────
// Markdown — redesigned for readability
// ─────────────────────────────────────────────────────────────

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
  const minimal = config.summaryStyle === 'minimal';
  const L: string[] = [];

  const cpuAvgPct = report.cpu.avg;
  const cpuPeakPct = report.cpu.max;
  const memAvgPct = safePct(report.memory.avg, report.memory.total_mb);
  const memPeakPct = safePct(report.memory.max, report.memory.total_mb);

  // ── Header: status + runner summary on one line ────────
  L.push('## 📊 RunnerLens\n');
  L.push(
    `**${badge(report)}** · ` +
    `${report.system.cpu_count} cores · ` +
    `${(report.system.total_memory_mb / 1024).toFixed(1)} GB RAM · ` +
    `${fmtDuration(report.duration_seconds)} · ` +
    `${report.sample_count} samples\n`,
  );

  // ── Action items first (recommendations + alerts) ──────
  const actions = [
    ...report.recommendations,
    ...(report.memory.swap_max_mb > 0
      ? [`⚠️ **Swap detected** — peak ${report.memory.swap_max_mb} MB. Your job is running out of memory.`]
      : []),
  ];

  if (actions.length > 0) {
    L.push('### ⚡ Action Required\n');
    for (const a of actions) L.push(`${a}\n`);
    L.push('');
  }

  // ── Dashboard: visual overview table ───────────────────
  L.push('### Dashboard\n');
  L.push('| | Resource | Usage | Peak | Detail |');
  L.push('|:---:|---|---|---|---|');

  // CPU row
  L.push(
    `| ${statusDot(cpuAvgPct, config.thresholds.cpu_warn, config.thresholds.cpu_crit)} ` +
    `| **CPU** ` +
    `| \`${progressBar(cpuAvgPct)}\` **${cpuAvgPct.toFixed(0)}%** avg ` +
    `| ${cpuPeakPct.toFixed(0)}% ` +
    `| p95: ${report.cpu.p95.toFixed(0)}% · p99: ${report.cpu.p99.toFixed(0)}% |`,
  );

  // Memory row
  const memUsedGB = (report.memory.avg / 1024).toFixed(1);
  const memTotalGB = (report.memory.total_mb / 1024).toFixed(1);
  L.push(
    `| ${statusDot(memAvgPct, config.thresholds.mem_warn, config.thresholds.mem_crit)} ` +
    `| **Memory** ` +
    `| \`${progressBar(memAvgPct)}\` **${memAvgPct.toFixed(0)}%** avg ` +
    `| ${memPeakPct.toFixed(0)}% ` +
    `| ${memUsedGB} / ${memTotalGB} GB |`,
  );

  L.push('');

  // ── Per-step breakdown ───────────────────────────────────
  if (report.steps && report.steps.length > 0) {
    L.push('<details open><summary><strong>📋 Per-Step Breakdown</strong></summary>\n');
    L.push('| # | Step | Duration | CPU avg | CPU peak | Mem avg | Mem peak |');
    L.push('|---:|---|---:|---:|---:|---:|---:|');
    for (const s of report.steps) {
      const memAvgGB = (s.mem_avg_mb / 1024).toFixed(1);
      const memMaxGB = (s.mem_max_mb / 1024).toFixed(1);
      L.push(
        `| ${s.number} ` +
        `| ${s.name} ` +
        `| ${fmtDuration(s.duration_seconds)} ` +
        `| ${s.cpu_avg.toFixed(0)}% ` +
        `| ${s.cpu_max.toFixed(0)}% ` +
        `| ${memAvgGB} GB ` +
        `| ${memMaxGB} GB |`,
      );
    }
    L.push('\n</details>\n');
  }

  // ── Alerts (only if not already shown via actions) ─────
  const pureAlerts = report.alerts.filter((a) =>
    a.metric !== 'Swap', // swap already shown in actions
  );
  if (pureAlerts.length > 0) {
    L.push('<details open><summary><strong>🚨 Alerts</strong></summary>\n');
    for (const a of pureAlerts) {
      const icon = a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟡' : '🔵';
      L.push(`${icon} **${a.metric}** — ${a.message}  `);
    }
    L.push('\n</details>\n');
  }

  // ── Timeline sparklines ────────────────────────────────
  if (!minimal) {
    const cpuV = samples.map((s) => s.cpu.usage);
    const memV = samples.map((s) => s.memory.usage_pct);
    if (cpuV.length >= 4) {
      L.push('<details open><summary><strong>📈 Timeline</strong></summary>\n');
      L.push('```');
      L.push(`  CPU  ${sparkline(cpuV, 50)}  ${cpuAvgPct.toFixed(0)}% avg`);
      L.push(`  MEM  ${sparkline(memV, 50)}  ${memAvgPct.toFixed(0)}% avg`);
      L.push('```');
      L.push('\n</details>\n');
    }
  }

  // ── Top processes (collapsed) ──────────────────────────
  if (full && config.includeProcesses && report.top_processes.length > 0) {
    L.push('<details><summary><strong>🔄 Top Processes</strong></summary>\n');
    L.push('| Process | Peak CPU | Memory |');
    L.push('|---|---:|---:|');
    for (const p of report.top_processes.slice(0, 6)) {
      L.push(`| \`${p.name}\` | ${p.cpu_pct.toFixed(1)}% | ${p.mem_mb.toFixed(0)} MB |`);
    }
    L.push('\n</details>\n');
  }

  // ── Runner details (collapsed) ─────────────────────────
  if (full) {
    L.push('<details><summary><strong>🖥️ Runner Details</strong></summary>\n');
    L.push(
      `**CPU:** ${report.system.cpu_count} × ${report.system.cpu_model}  \n` +
      `**RAM:** ${report.system.total_memory_mb.toLocaleString()} MB  \n` +
      `**OS:** ${report.system.os_release} · Kernel ${report.system.kernel}  \n` +
      `**Runner:** ${report.system.runner_name} (${report.system.runner_os}/${report.system.runner_arch})`,
    );
    L.push('\n</details>\n');
  }

  // ── Footer ─────────────────────────────────────────────
  L.push('---');
  const collectorInfo = report.collector
    ? ` · Sampling: ${report.collector.avg_cpu_pct.toFixed(1)}% CPU · ${report.collector.avg_mem_mb.toFixed(1)} MB RAM`
    : '';
  L.push(
    `<sub><a href="https://runnerlens.com">RunnerLens</a> ` +
    `v${REPORT_VERSION} · ${report.started_at} → ${report.ended_at}${collectorInfo}</sub>`,
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
  steps?: StepMetrics[],
): { report: AggregatedReport; markdown: string } {
  const report = aggregate(samples, sysInfo, config, durationSec, steps);
  const md = config.summaryStyle === 'none' ? '' : markdown(report, samples, config);
  return { report, markdown: md };
}
