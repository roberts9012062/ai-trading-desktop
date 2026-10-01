#!/usr/bin/env bash
# 短周期达标力度升级:15m/5m/1m @ 3000x100(m3.3 全算子+种子库)
set -uo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:4210"
OUT=".local-data/factor-verify"
# 等待 queue2 结束(其输出文件出现 queue done 标记)
while ! grep -q "m3.3 queue done" "$OUT/../factor-verify/.queue2.done" 2>/dev/null; do
  if ! pgrep -f "factor-verify-native-queue2.sh" >/dev/null 2>&1; then break; fi
  sleep 30
done
run() {
  local symbol="$1" tf="$2" pop="$3" gen="$4"
  echo "=== native ESC $symbol $tf ${pop}x${gen} ==="
  python scripts/factor-verify-native-gpu.py --url "$URL" --symbol "$symbol" --tf "$tf" \
    --population "$pop" --generations "$gen" \
    --out "$OUT/native-esc-${symbol}-${tf}.json" 2>&1 | tail -2
}
run BTCUSDT 15m 3000 100
run ETHUSDT 15m 3000 100
run BTCUSDT 5m 3000 100
run BTCUSDT 1m 3000 100
echo "=== esc queue done ==="
