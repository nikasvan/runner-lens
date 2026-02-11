#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# RunnerLens — Background Metric Collector (v2)
#
# Reads directly from /proc for minimal overhead.
# Writes one JSON line per sample to the output file.
#
# Usage: collect.sh <output> <interval> [flags...]
#   --no-processes  skip top-process capture
#   --max-size=N    max output file size in MB (default: 100, 0=unlimited)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

readonly OUT="${1:?Usage: collect.sh <output> <interval> [--no-processes] [--max-size=N]}"
readonly INTERVAL="${2:-3}"
shift 2 2>/dev/null || true

readonly DEFAULT_MAX_SIZE_MB=100

OPT_PROC=1  MAX_SIZE_MB="$DEFAULT_MAX_SIZE_MB"
for a in "$@"; do
  case "$a" in
    --no-processes) OPT_PROC=0 ;;
    --max-size=*)   MAX_SIZE_MB="${a#--max-size=}" ;;
  esac
done

# ── validate ───────────────────────────────────────────────
if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || (( INTERVAL < 1 || INTERVAL > 30 )); then
  echo "ERROR: interval must be 1-30" >&2; exit 1
fi
if ! [[ "$MAX_SIZE_MB" =~ ^[0-9]+$ ]]; then
  echo "ERROR: max-size must be a non-negative integer" >&2; exit 1
fi

# ── clean shutdown (set early so seed phase is covered) ────
trap 'exit 0' SIGTERM SIGINT

# ── previous-sample state for delta calculations ───────────
p_user=0 p_nice=0 p_sys=0 p_idle=0 p_iow=0 p_irq=0 p_sirq=0 p_steal=0
p_self_ticks=0

# ── collector self-monitoring ──────────────────────────────
readonly CLK_TCK=$(getconf CLK_TCK 2>/dev/null || echo 100)

read_self_cpu_ticks() {
  # /proc/self/stat: 14=utime 15=stime 16=cutime 17=cstime
  # Include child process time (awk, ps, date) for true overhead
  awk '{print $14+$15+$16+$17}' /proc/self/stat 2>/dev/null || echo 0
}

read_self_mem_mb() {
  awk '/^VmRSS:/ {printf "%.1f", $2/1024; exit}' /proc/self/status 2>/dev/null || echo 0
}

# ── helpers ────────────────────────────────────────────────

read_cpu_raw() {
  read -r _ u n s i w q sq st _ < /proc/stat
  echo "$u $n $s $i $w $q $sq ${st:-0}"
}

# Compute all CPU percentages in a single awk call (1 fork instead of 6)
calc_cpu_pcts() {
  awk -v du="$1" -v dn="$2" -v ds="$3" -v di="$4" \
      -v dw="$5" -v dq="$6" -v dsq="$7" -v dst="$8" '
    BEGIN {
      dt = du+dn+ds+di+dw+dq+dsq+dst
      if (dt > 0) {
        printf "%.1f %.1f %.1f %.1f %.1f %.1f",
          (du+dn)/dt*100, (ds+dq+dsq)/dt*100, di/dt*100,
          dw/dt*100, dst/dt*100, 100-di/dt*100
      } else {
        print "0.0 0.0 100.0 0.0 0.0 0.0"
      }
    }'
}

read_mem() {
  awk '
    /^MemTotal:/     {t=$2}
    /^MemAvailable:/ {a=$2}
    /^Cached:/       {c=$2}
    /^SwapTotal:/    {st=$2}
    /^SwapFree:/     {sf=$2}
    END {
      u=t-a; su=st-sf
      mt=int(t/1024); mu=int(u/1024); ma=int(a/1024)
      mc=int(c/1024); mst=int(st/1024); msu=int(su/1024)
      if (mt > 0) mp=mu/mt*100; else mp=0
      printf "%d %d %d %d %d %d %.1f", mt,mu,ma,mc,mst,msu,mp
    }
  ' /proc/meminfo
}

read_load() { awk '{printf "%s %s %s",$1,$2,$3}' /proc/loadavg; }

read_procs() {
  ps -eo pid=,comm=,%cpu=,rss= --sort=-%cpu --no-headers 2>/dev/null |
    head -5 | awk '
      BEGIN { f=1 }
      {
        if (!f) printf ","
        f=0
        name=$2
        gsub(/[\\]/, "\\\\", name)
        gsub(/"/, "\\\"", name)
        gsub(/[\x00-\x1f]/, "", name)
        printf "{\"pid\":%s,\"name\":\"%s\",\"cpu_pct\":%s,\"mem_mb\":%.1f}",
               $1, name, $3, $4/1024
      }'
}

clamp0() { (( $1 < 0 )) && echo 0 || echo "$1"; }

maybe_rotate() {
  (( MAX_SIZE_MB == 0 )) && return
  if [[ -f "$OUT" ]]; then
    local size_mb
    size_mb=$(( $(stat -c%s "$OUT" 2>/dev/null || echo 0) / 1048576 ))
    if (( size_mb >= MAX_SIZE_MB )); then
      mv -f "$OUT" "${OUT}.1"
    fi
  fi
}

# ── seed previous counters (first read is discarded) ───────
read -r p_user p_nice p_sys p_idle p_iow p_irq p_sirq p_steal <<< "$(read_cpu_raw)"
p_self_ticks=$(read_self_cpu_ticks)

sleep "$INTERVAL"

# ── main loop ──────────────────────────────────────────────
while true; do
  ts=$(date +%s)

  # ── CPU (delta) ──────────────────────────────────────────
  read -r cu cn cs ci cw cq csq cst <<< "$(read_cpu_raw)"

  du=$(( cu - p_user ))  dn=$(( cn - p_nice ))
  ds=$(( cs - p_sys  ))  di=$(( ci - p_idle ))
  dw=$(( cw - p_iow  ))  dq=$(( cq - p_irq ))
  dsq=$(( csq - p_sirq ))  dst=$(( cst - p_steal ))

  read -r cpu_u cpu_s cpu_id cpu_w cpu_st cpu_pct <<< "$(calc_cpu_pcts $du $dn $ds $di $dw $dq $dsq $dst)"

  p_user=$cu p_nice=$cn p_sys=$cs p_idle=$ci
  p_iow=$cw  p_irq=$cq  p_sirq=$csq p_steal=$cst

  # ── Memory (includes usage_pct in single awk call) ──────
  read -r mt mu ma mc stt su mp <<< "$(read_mem)"

  # ── Load ────────────────────────────────────────────────
  read -r l1 l5 l15 <<< "$(read_load)"

  # ── Collector self-monitoring ────────────────────────────
  c_self_ticks=$(read_self_cpu_ticks)
  c_self_delta=$(( c_self_ticks - p_self_ticks ))
  (( c_self_delta < 0 )) && c_self_delta=0
  c_self_cpu=$(awk -v d="$c_self_delta" -v hz="$CLK_TCK" -v i="$INTERVAL" \
    'BEGIN { v=d/(hz*i)*100; if(v>100)v=100; printf "%.1f",v }')
  c_self_mem=$(read_self_mem_mb)
  p_self_ticks=$c_self_ticks

  # ── Processes ───────────────────────────────────────────
  pr='"processes":[]'
  if (( OPT_PROC )); then
    pr="\"processes\":[$(read_procs)]"
  fi

  # ── Rotate if needed, then emit JSONL line ──────────────
  maybe_rotate

  printf '{"timestamp":%s,"cpu":{"user":%s,"system":%s,"idle":%s,"iowait":%s,"steal":%s,"usage":%s},"memory":{"total_mb":%s,"used_mb":%s,"available_mb":%s,"cached_mb":%s,"swap_total_mb":%s,"swap_used_mb":%s,"usage_pct":%s},"load":{"load1":%s,"load5":%s,"load15":%s},%s,"collector":{"cpu_pct":%s,"mem_mb":%s}}\n' \
    "$ts" "$cpu_u" "$cpu_s" "$cpu_id" "$cpu_w" "$cpu_st" "$cpu_pct" \
    "$mt" "$mu" "$ma" "$mc" "$stt" "$su" "$mp" \
    "$l1" "$l5" "$l15" \
    "$pr" "$c_self_cpu" "$c_self_mem" >> "$OUT"

  sleep "$INTERVAL"
done
