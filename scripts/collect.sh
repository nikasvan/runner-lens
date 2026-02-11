#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# RunnerLens — Background Metric Collector (v2)
#
# Reads directly from /proc for minimal overhead.
# Writes one JSON line per sample to the output file.
#
# Usage: collect.sh <output> <interval> [flags...]
#   --no-processes  skip top-process capture
#   --no-network    skip network I/O deltas
#   --no-disk       skip disk I/O deltas + disk space
#   --max-size=N    max output file size in MB (default: 100, 0=unlimited)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

readonly OUT="${1:?Usage: collect.sh <output> <interval> [--no-processes] [--no-network] [--no-disk] [--max-size=N]}"
readonly INTERVAL="${2:-3}"
shift 2 2>/dev/null || true

readonly SECTOR_BYTES=512
readonly DEFAULT_MAX_SIZE_MB=100

OPT_PROC=1  OPT_NET=1  OPT_DISK=1  MAX_SIZE_MB="$DEFAULT_MAX_SIZE_MB"
for a in "$@"; do
  case "$a" in
    --no-processes) OPT_PROC=0 ;;
    --no-network)   OPT_NET=0 ;;
    --no-disk)      OPT_DISK=0 ;;
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
p_dr=0 p_dw=0 p_dro=0 p_dwo=0
p_nr=0 p_nt=0 p_nrp=0 p_ntp=0

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

read_disk_io() {
  awk -v sb="$SECTOR_BYTES" '
    $3 ~ /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+)$/ {
      rb+=$6; wb+=$10; ro+=$4; wo+=$8
    }
    END { printf "%d %d %d %d", rb*sb, wb*sb, ro, wo }
  ' /proc/diskstats
}

read_net() {
  awk 'NR>2 && $1!~/lo:/ {
    gsub(/:/, "", $1); r+=$2; t+=$10; rp+=$3; tp+=$11
  }
  END { printf "%d %d %d %d", r, t, rp, tp }' /proc/net/dev
}

read_load() { awk '{printf "%s %s %s",$1,$2,$3}' /proc/loadavg; }

read_disk_space() {
  df -BM --output=target,size,used,avail,pcent 2>/dev/null |
    awk 'NR>1 && ($1=="/" || $1~/^\/home/ || $1~/^\/mnt/) {
      gsub(/[M%]/, "", $0)
      printf "%s{\"mount\":\"%s\",\"total_mb\":%s,\"used_mb\":%s,\"available_mb\":%s,\"usage_pct\":%s}",
             (n++ ? "," : ""), $1, $2, $3, $4, $5
    }'
}

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
(( OPT_DISK )) && read -r p_dr p_dw p_dro p_dwo <<< "$(read_disk_io)"
(( OPT_NET  )) && read -r p_nr p_nt p_nrp p_ntp <<< "$(read_net)"

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

  # ── Disk I/O (delta) ────────────────────────────────────
  d_io='"disk_io":{"read_bytes":0,"write_bytes":0,"read_ops":0,"write_ops":0}'
  if (( OPT_DISK )); then
    read -r cdr cdw cdro cdwo <<< "$(read_disk_io)"
    ddr=$(clamp0 $(( cdr - p_dr )))
    ddw=$(clamp0 $(( cdw - p_dw )))
    ddro=$(clamp0 $(( cdro - p_dro )))
    ddwo=$(clamp0 $(( cdwo - p_dwo )))
    d_io="\"disk_io\":{\"read_bytes\":${ddr},\"write_bytes\":${ddw},\"read_ops\":${ddro},\"write_ops\":${ddwo}}"
    p_dr=$cdr p_dw=$cdw p_dro=$cdro p_dwo=$cdwo
  fi

  # ── Disk Space ──────────────────────────────────────────
  d_sp='"disk_space":[]'
  if (( OPT_DISK )); then
    d_sp="\"disk_space\":[$(read_disk_space)]"
  fi

  # ── Network (delta) ─────────────────────────────────────
  n_io='"network":{"rx_bytes":0,"tx_bytes":0,"rx_packets":0,"tx_packets":0}'
  if (( OPT_NET )); then
    read -r cnr cnt cnrp cntp <<< "$(read_net)"
    dnr=$(clamp0 $(( cnr - p_nr )))
    dnt=$(clamp0 $(( cnt - p_nt )))
    dnrp=$(clamp0 $(( cnrp - p_nrp )))
    dntp=$(clamp0 $(( cntp - p_ntp )))
    n_io="\"network\":{\"rx_bytes\":${dnr},\"tx_bytes\":${dnt},\"rx_packets\":${dnrp},\"tx_packets\":${dntp}}"
    p_nr=$cnr p_nt=$cnt p_nrp=$cnrp p_ntp=$cntp
  fi

  # ── Processes ───────────────────────────────────────────
  pr='"processes":[]'
  if (( OPT_PROC )); then
    pr="\"processes\":[$(read_procs)]"
  fi

  # ── Rotate if needed, then emit JSONL line ──────────────
  maybe_rotate

  printf '{"timestamp":%s,"cpu":{"user":%s,"system":%s,"idle":%s,"iowait":%s,"steal":%s,"usage":%s},"memory":{"total_mb":%s,"used_mb":%s,"available_mb":%s,"cached_mb":%s,"swap_total_mb":%s,"swap_used_mb":%s,"usage_pct":%s},%s,%s,%s,"load":{"load1":%s,"load5":%s,"load15":%s},%s}\n' \
    "$ts" "$cpu_u" "$cpu_s" "$cpu_id" "$cpu_w" "$cpu_st" "$cpu_pct" \
    "$mt" "$mu" "$ma" "$mc" "$stt" "$su" "$mp" \
    "$d_io" "$d_sp" "$n_io" \
    "$l1" "$l5" "$l15" \
    "$pr" >> "$OUT"

  sleep "$INTERVAL"
done
