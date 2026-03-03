#!/bin/sh
# ─────────────────────────────────────────────────────────────
# RunnerLens — Background Metric Collector (v2)
#
# POSIX sh — works on Alpine, Ubuntu, and all Linux runners.
# Reads directly from /proc for minimal overhead.
# Writes one JSON line per sample to the output file.
#
# Usage: collect.sh <output> <interval> [--max-size=N]
# ─────────────────────────────────────────────────────────────
set -eu

OUT="${1:?Usage: collect.sh <output> <interval> [--max-size=N]}"
INTERVAL="${2:-3}"
shift 2 2>/dev/null || true

MAX_SIZE_MB=100
for a in "$@"; do
  case "$a" in
    --max-size=*) MAX_SIZE_MB="${a#--max-size=}" ;;
  esac
done

# ── validate ───────────────────────────────────────────────
case "$INTERVAL" in
  *[!0-9]*|'') echo "ERROR: interval must be 1-30" >&2; exit 1 ;;
esac
[ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 30 ] || {
  echo "ERROR: interval must be 1-30" >&2; exit 1
}
case "$MAX_SIZE_MB" in
  *[!0-9]*|'') echo "ERROR: max-size must be a non-negative integer" >&2; exit 1 ;;
esac

# ── ensure output directory exists ─────────────────────────
mkdir -p "$(dirname "$OUT")"

# ── clean shutdown (set early so seed phase is covered) ────
trap 'exit 0' TERM INT

# ── previous-sample state for delta calculations ───────────
p_user=0 p_nice=0 p_sys=0 p_idle=0 p_iow=0 p_irq=0 p_sirq=0 p_steal=0
p_self_ticks=0
p_ts=0

# ── collector self-monitoring ──────────────────────────────
CLK_TCK=$(getconf CLK_TCK 2>/dev/null || echo 100)

read_self_cpu_ticks() {
  # /proc/self/stat: 14=utime 15=stime 16=cutime 17=cstime
  awk '{print $14+$15+$16+$17}' /proc/self/stat 2>/dev/null || echo 0
}

read_self_mem_mb() {
  awk '/^VmRSS:/ {printf "%.1f", $2/1024; exit}' /proc/self/status 2>/dev/null || echo 0
}

# ── helpers ────────────────────────────────────────────────

read_cpu_raw() {
  if ! read -r _ u n s i w q sq st _ < /proc/stat 2>/dev/null; then
    echo "0 0 0 0 0 0 0 0"
    return
  fi
  # ${st:-0}: steal column was added in Linux 2.6.11; absent on very old kernels
  echo "$u $n $s $i $w $q $sq ${st:-0}"
}

# Compute all CPU percentages in a single awk call (1 fork instead of 6)
# Output: user nice system idle iowait steal usage (7 values)
# Matches standard breakdown: user and nice are separate (like top/mpstat),
# system includes irq+softirq (like vmstat's sy column).
calc_cpu_pcts() {
  awk -v du="$1" -v dn="$2" -v ds="$3" -v di="$4" \
      -v dw="$5" -v dq="$6" -v dsq="$7" -v dst="$8" '
    BEGIN {
      dt = du+dn+ds+di+dw+dq+dsq+dst
      if (dt > 0) {
        printf "%.1f %.1f %.1f %.1f %.1f %.1f %.1f",
          du/dt*100, dn/dt*100, (ds+dq+dsq)/dt*100, di/dt*100,
          dw/dt*100, dst/dt*100, 100-di/dt*100
      } else {
        print "0.0 0.0 0.0 100.0 0.0 0.0 0.0"
      }
    }'
}

read_mem() {
  awk '
    /^MemTotal:/     {t=$2}
    /^MemAvailable:/ {a=$2}
    /^Buffers:/      {b=$2}
    /^Cached:/       {c=$2}
    /^SReclaimable:/ {sr=$2}
    /^SwapTotal:/    {swt=$2}
    /^SwapFree:/     {sf=$2}
    END {
      u=t-a; su=swt-sf
      # cached = Buffers + Cached + SReclaimable (matches `free` command)
      cached=b+c+sr
      mt=int(t/1024); mu=int(u/1024); ma=int(a/1024)
      mc=int(cached/1024); mst=int(swt/1024); msu=int(su/1024)
      if (mt > 0) mp=mu/mt*100; else mp=0
      printf "%d %d %d %d %d %d %.1f", mt,mu,ma,mc,mst,msu,mp
    }
  ' /proc/meminfo
}

read_load() { awk '{printf "%s %s %s",$1,$2,$3}' /proc/loadavg; }

maybe_rotate() {
  [ "$MAX_SIZE_MB" -eq 0 ] && return 0
  if [ -f "$OUT" ]; then
    # stat -c%s is GNU coreutils / busybox — fine for Linux runners
    size_bytes=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
    size_mb=$((size_bytes / 1048576))
    if [ "$size_mb" -ge "$MAX_SIZE_MB" ]; then
      # Keeps at most two files: current + one rotated backup.
      # The previous .1 is discarded to cap disk usage.
      mv -f "$OUT" "${OUT}.1"
    fi
  fi
}

# ── seed previous counters (first read is discarded) ───────
set -- $(read_cpu_raw)
[ $# -eq 8 ] || { echo "ERROR: unexpected /proc/stat format" >&2; exit 1; }
p_user=$1 p_nice=$2 p_sys=$3 p_idle=$4 p_iow=$5 p_irq=$6 p_sirq=$7 p_steal=$8
p_self_ticks=$(read_self_cpu_ticks)
p_ts=$(date +%s)

sleep "$INTERVAL" || true

# ── main loop ──────────────────────────────────────────────
while true; do
  ts=$(date +%s)

  # ── CPU (delta) ──────────────────────────────────────────
  set -- $(read_cpu_raw)
  if [ $# -ne 8 ]; then
    sleep "$INTERVAL" || true
    continue
  fi
  cu=$1 cn=$2 cs=$3 ci=$4 cw=$5 cq=$6 csq=$7 cst=$8

  du=$((cu - p_user))  dn=$((cn - p_nice))
  ds=$((cs - p_sys))   di=$((ci - p_idle))
  dw=$((cw - p_iow))   dq=$((cq - p_irq))
  dsq=$((csq - p_sirq)) dst=$((cst - p_steal))

  set -- $(calc_cpu_pcts $du $dn $ds $di $dw $dq $dsq $dst)
  if [ $# -ne 7 ]; then
    sleep "$INTERVAL" || true
    continue
  fi
  cpu_u=$1 cpu_n=$2 cpu_s=$3 cpu_id=$4 cpu_w=$5 cpu_st=$6 cpu_pct=$7

  p_user=$cu p_nice=$cn p_sys=$cs p_idle=$ci
  p_iow=$cw  p_irq=$cq  p_sirq=$csq p_steal=$cst

  # ── Memory ──────────────────────────────────────────────
  set -- $(read_mem)
  if [ $# -ne 7 ]; then
    sleep "$INTERVAL" || true
    continue
  fi
  mt=$1 mu=$2 ma=$3 mc=$4 stt=$5 su=$6 mp=$7

  # ── Load ────────────────────────────────────────────────
  set -- $(read_load)
  if [ $# -ne 3 ]; then
    sleep "$INTERVAL" || true
    continue
  fi
  l1=$1 l5=$2 l15=$3

  # ── Collector self-monitoring ────────────────────────────
  c_self_ticks=$(read_self_cpu_ticks)
  c_self_delta=$((c_self_ticks - p_self_ticks))
  if [ "$c_self_delta" -lt 0 ]; then c_self_delta=0; fi
  # Use real wall-clock elapsed time instead of $INTERVAL to account for drift
  elapsed=$((ts - p_ts))
  if [ "$elapsed" -le 0 ]; then elapsed=$INTERVAL; fi
  c_self_cpu=$(awk -v d="$c_self_delta" -v hz="$CLK_TCK" -v i="$elapsed" \
    'BEGIN { v=d/(hz*i)*100; if(v>100)v=100; printf "%.1f",v }')
  c_self_mem=$(read_self_mem_mb)
  p_self_ticks=$c_self_ticks
  p_ts=$ts

  # ── Rotate if needed, then emit JSONL line ──────────────
  maybe_rotate

  printf '%s\n' \
    "{\"timestamp\":${ts},\"cpu\":{\"user\":${cpu_u},\"nice\":${cpu_n},\"system\":${cpu_s},\"idle\":${cpu_id},\"iowait\":${cpu_w},\"steal\":${cpu_st},\"usage\":${cpu_pct}},\"memory\":{\"total_mb\":${mt},\"used_mb\":${mu},\"available_mb\":${ma},\"cached_mb\":${mc},\"swap_total_mb\":${stt},\"swap_used_mb\":${su},\"usage_pct\":${mp}},\"load\":{\"load1\":${l1},\"load5\":${l5},\"load15\":${l15}},\"collector\":{\"cpu_pct\":${c_self_cpu},\"mem_mb\":${c_self_mem}}}" >> "$OUT"

  sleep "$INTERVAL" || true
done
