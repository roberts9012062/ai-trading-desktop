#!/usr/bin/env bash
# m3.3 全算子后的原生重跑:弱周期(1d/15m/5m/1m)+ 30m 复验
set -uo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:4210"
OUT=".local-data/factor-verify"
run() {
  local symbol="$1" tf="$2" pop="$3" gen="$4"; shift 4
  echo "=== native m3.3 $symbol $tf ${pop}x${gen} $* ==="
  python scripts/factor-verify-native-gpu.py --url "$URL" --symbol "$symbol" --tf "$tf" \
    --population "$pop" --generations "$gen" "$@" \
    --out "$OUT/native-m33-${symbol}-${tf}.json" 2>&1 | tail -2
}
run BTCUSDT 1d 600 40
run ETHUSDT 1d 600 40
run BTCUSDT 15m 600 40
run BTCUSDT 5m 600 40
run BTCUSDT 1m 600 40
run BTCUSDT 30m 600 40
echo "=== m3.3 queue done ==="
