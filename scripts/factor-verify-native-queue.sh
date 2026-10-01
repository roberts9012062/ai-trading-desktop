#!/usr/bin/env bash
# 原生 GPU 全周期验证队列(串行,每跑一个起一次引擎,~8min 预热 + 挖掘)
set -uo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:4210"
OUT=".local-data/factor-verify"

run() { # symbol tf pop gen [extra]
  local symbol="$1" tf="$2" pop="$3" gen="$4"; shift 4
  echo "=== native $symbol $tf ${pop}x${gen} $* ==="
  python scripts/factor-verify-native-gpu.py --url "$URL" --symbol "$symbol" --tf "$tf" \
    --population "$pop" --generations "$gen" "$@" \
    --out "$OUT/native-${symbol}-${tf}-$(date +%H%M%S).json" 2>&1 | tail -3
}

run BTCUSDT 1d 3000 100
run BTCUSDT 15m 600 40
run BTCUSDT 5m 600 40
run BTCUSDT 1m 600 40
echo "=== queue done ==="
