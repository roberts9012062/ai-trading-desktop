#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:4210"
OUT=".local-data/factor-verify"
run() {
  echo "=== native ESC $1 $2 $3x$4 ==="
  python scripts/factor-verify-native-gpu.py --url "$URL" --symbol "$1" --tf "$2" --population "$3" --generations "$4" \
    --out "$OUT/native-esc-$1-$2.json" 2>&1 | tail -2
}
run BTCUSDT 5m 3000 100
run BTCUSDT 1m 3000 100
echo "=== esc2 done ==="
