import type { AggregatedReport, MetricSample } from './types';

export function recommend(report: AggregatedReport, samples: MetricSample[]): string[] {
  if (samples.length === 0) return [];

  const r: string[] = [];
  const { cpu, memory, system } = report;
  const memTotalMb = memory.total_mb;

  // ── Oversized runner ────────────────────────────────────
  if (cpu.max < 30 && memTotalMb > 0 && memory.max < memTotalMb * 0.3) {
    r.push(
      '💰 **Oversized runner** — peak CPU <30 % and memory <30 %. ' +
      'A smaller runner would cut costs with no performance impact.',
    );
  }

  // ── Under-sized runner ──────────────────────────────────
  if (cpu.p95 > 90 && system.cpu_count <= 2) {
    r.push(
      '⚡ **CPU saturated** — p95 >90 % on a 2-core runner. ' +
      'Upgrade to `ubuntu-latest-4-cores` or larger.',
    );
  }

  // ── Memory near capacity ────────────────────────────────
  if (memTotalMb > 0 && memory.max > memTotalMb * 0.85) {
    r.push(
      '🧠 **Memory pressure** — peak usage >85 % of available RAM. ' +
      'Consider a larger runner or reduce parallel processes.',
    );
  }

  // ── I/O wait bottleneck ─────────────────────────────────
  const avgIow = samples.reduce((s, x) => s + x.cpu.iowait, 0) / samples.length;
  if (avgIow > 15) {
    r.push(
      '💾 **I/O bottleneck** — average iowait ' +
      `${avgIow.toFixed(1)} %. ` +
      'Cache dependencies or move heavy writes to /dev/shm (tmpfs).',
    );
  }

  return r;
}
