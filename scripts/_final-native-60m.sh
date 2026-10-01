#!/usr/bin/env bash
cd "$(dirname "$0")/.."
while pgrep -f "factor-verify-native-queue4.sh" >/dev/null 2>&1; do sleep 30; done
python scripts/factor-verify-native-gpu.py --url http://127.0.0.1:4210 --symbol BTCUSDT --tf 60m \
  --population 600 --generations 40 --out .local-data/factor-verify/native-m33-BTCUSDT-60m.json 2>&1 | tail -2
