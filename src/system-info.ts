import * as os from 'os';
import * as fs from 'fs';
import * as exec from '@actions/exec';
import type { SystemInfo } from './types';

async function capture(cmd: string, args: string[]): Promise<string> {
  let out = '';
  try {
    await exec.exec(cmd, args, {
      listeners: { stdout: (d: Buffer) => { out += d.toString(); } },
      silent: true,
    });
  } catch { /* swallow */ }
  return out.trim();
}

export async function collectSystemInfo(): Promise<SystemInfo> {
  const cpus = os.cpus();

  let osRelease = 'unknown';
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf-8');
    const m = content.match(/PRETTY_NAME="(.+?)"/);
    if (m) osRelease = m[1];
  } catch { /* ok */ }

  return {
    cpu_count: cpus.length,
    cpu_model: cpus[0]?.model ?? 'unknown',
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    os_release: osRelease,
    kernel: await capture('uname', ['-r']) || 'unknown',
    runner_name: process.env.RUNNER_NAME ?? 'unknown',
    runner_os: process.env.RUNNER_OS ?? 'unknown',
    runner_arch: process.env.RUNNER_ARCH ?? 'unknown',
  };
}
