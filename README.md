# 📊 RunnerLens

**Zero-config observability for GitHub Actions runners.**

Drop RunnerLens into any workflow and get CPU, memory, disk I/O, and network metrics with sparkline charts directly in your Job Summary — no infrastructure required.

## Quick Start

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: runnerlens/runner-lens@v1   # ← add this line
      - uses: actions/checkout@v4
      - run: npm ci && npm test
```

That's it. When the job finishes, you'll see a resource report in the **Job Summary** tab.

## What You Get

- **CPU** — average, peak, p95, p99 with sparkline timeline
- **Memory** — usage, swap detection, pressure alerts
- **Disk I/O** — total read/written, throughput, space warnings
- **Network** — bytes received/sent, packet counts
- **Alerts** — threshold-based warnings for CPU, memory, swap, I/O wait, CPU steal, disk space
- **Recommendations** — right-sizing advice (oversized runner, CPU saturation, cache opportunities)
- **Top Processes** — peak CPU consumers across the job

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | `''` | RunnerLens SaaS API key (optional) |
| `api-endpoint` | `https://api.runnerlens.com` | API endpoint override |
| `sample-interval` | `3` | Seconds between samples (1–30) |
| `include-processes` | `true` | Capture top processes |
| `include-network` | `true` | Capture network I/O |
| `include-disk` | `true` | Capture disk I/O and space |
| `summary-style` | `full` | Report detail: `full` \| `compact` \| `minimal` \| `none` |
| `max-file-size` | `100` | Max metrics file size in MB before rotation (0 = unlimited) |
| `threshold-cpu-warn` | `80` | CPU % warning threshold |
| `threshold-cpu-crit` | `95` | CPU % critical threshold |
| `threshold-mem-warn` | `80` | Memory % warning threshold |
| `threshold-mem-crit` | `95` | Memory % critical threshold |

## Outputs

| Output | Example | Description |
|---|---|---|
| `cpu-avg` | `34.2` | Average CPU usage % |
| `cpu-max` | `87.1` | Peak CPU usage % |
| `cpu-p95` | `72.5` | 95th percentile CPU % |
| `mem-avg-mb` | `2048` | Average memory usage (MB) |
| `mem-max-mb` | `3584` | Peak memory usage (MB) |
| `mem-avg-pct` | `56.3` | Average memory usage % |
| `disk-read-mb` | `245.3` | Total disk read (MB) |
| `disk-write-mb` | `89.7` | Total disk written (MB) |
| `net-rx-mb` | `312.8` | Total network received (MB) |
| `net-tx-mb` | `24.5` | Total network sent (MB) |
| `samples` | `120` | Number of samples collected |
| `duration-seconds` | `360` | Monitoring wall-clock duration |
| `report-json` | `{...}` | Full report as JSON |

### Using Outputs

```yaml
- uses: runnerlens/runner-lens@v1
  id: lens

- run: npm ci && npm test

- name: Fail if CPU was critically high
  if: always()
  run: |
    cpu_p95="${{ steps.lens.outputs.cpu-p95 }}"
    if (( $(echo "$cpu_p95 > 95" | bc -l) )); then
      echo "::error::CPU p95 was ${cpu_p95}%"
      exit 1
    fi
```

## Architecture

RunnerLens uses a two-phase design:

1. **Main step** — spawns a lightweight bash collector as a detached background process
2. **Post step** (`post-if: always()`) — stops the collector, aggregates data, writes the Job Summary

The bash collector reads directly from `/proc` (CPU, memory, disk, network) with <0.5% CPU overhead. It outputs one JSON line per sample to a temp file.

### File Rotation

For long-running jobs (multi-hour builds on self-hosted runners), the collector automatically rotates the metrics file when it exceeds `max-file-size` MB. The TypeScript post-processor reads both the rotated and current files, sorts samples chronologically, and produces a single unified report.

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  main step  │────▶│  collect.sh  │────▶│  metrics.jsonl │
│  (spawn)    │     │  (detached)  │     │  (JSONL /proc) │
└─────────────┘     └──────────────┘     └────────────────┘
                                                │
┌─────────────┐     ┌──────────────┐            │
│  post step  │────▶│  reporter.ts │◀───────────┘
│  (always)   │     │  (aggregate) │
└─────────────┘     └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        Job Summary    Outputs    API (optional)
```

## SaaS Dashboard (Coming Soon)

Add an `api-key` to unlock:

- **Historical trends** across runs
- **Cross-workflow comparisons**
- **Team-wide cost analytics**
- **Slack/email alerting**

```yaml
- uses: runnerlens/runner-lens@v1
  with:
    api-key: ${{ secrets.RUNNERLENS_API_KEY }}
```

## Development

```bash
npm ci
npm run typecheck    # TypeScript strict mode
npm test             # Jest with coverage
npm run build        # esbuild → dist/
```

### Project Structure

```
├── action.yml                 # GitHub Action definition
├── scripts/collect.sh         # Bash /proc collector (v2)
├── src/
│   ├── main.ts                # Entry: spawn collector
│   ├── post.ts                # Post: stop, aggregate, report
│   ├── config.ts              # Input parsing & validation
│   ├── constants.ts           # Shared paths & state keys
│   ├── types.ts               # All TypeScript interfaces
│   ├── system-info.ts         # Static runner metadata
│   ├── stats.ts               # Percentile, avg, min/max (stack-safe)
│   ├── charts.ts              # ASCII sparklines & formatting
│   ├── alerts.ts              # Threshold evaluation
│   ├── recommendations.ts     # Right-sizing engine
│   ├── reporter.ts            # Aggregation + markdown generation
│   └── api-client.ts          # SaaS upload (gzip, retries)
├── dist/                      # Bundled JS (checked in)
├── __tests__/                 # Jest test suite
└── .github/workflows/ci.yml   # CI with dogfooding
```

## License

MIT
