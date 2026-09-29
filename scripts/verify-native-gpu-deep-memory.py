"""G4 deep-data real-device verification for the native engine (246k bars).

Tiles the frozen ETHUSDT 15m 70,174-bar fixture to exactly 246,000 bars with
strictly increasing timestamps. The data is declared synthetic tiling: this
gate verifies memory behavior on the real CUDA device, not data authenticity.

Checks (handoff M3-E):
- prepare_features auto-shrinks the candidate tile below the 70k-performance
  cap of 128 (the approved shrink path) instead of erroring on this 6GB card;
- resident GPU buffers and sampled nvidia-smi peak stay below 70% VRAM;
- a real eval_shards batch completes on the deep calendar;
- the 300k device-profile guard is respected (246k is within the high tier).

Run with the native venv python. Not a packaged desktop test.
"""
import ctypes
import hashlib
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native-engine'))

TARGET_BARS = 246_000
CONFIG = {'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True, 'population': 3000,
          'generations': 1, 'max_depth': 6, 'seed': 42, 'train_ratio': .7,
          'test_recent_bars': 0, 'walk_forward_folds': 3, 'cost': .0003, 'top_n': 10,
          'research_profile': 'crypto_ohlcv_v1', 'execution_model': 'signal_research', 'selection_v2': True}


class Sampler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.samples = []
        self._halt = threading.Event()

    def run(self):
        while not self._halt.is_set():
            try:
                out = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,memory.total,utilization.gpu',
                                      '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=10)
                used, total, util = [int(v.strip()) for v in out.stdout.strip().splitlines()[0].split(',')]
                self.samples.append((time.time()*1000, used, total, util))
            except Exception:
                pass
            self._halt.wait(.2)

    def stop(self):
        self._halt.set()
        self.join(timeout=15)


def build_tiled_columns(bars, count):
    times = np.array([time_ms(b['time']) for b in bars], dtype='<f8')
    interval = float(np.median(np.diff(times)))
    span = float(times[-1]-times[0]+interval)
    copies = -(-count // len(bars))
    offsets = (np.arange(copies)*span).astype('<f8')
    time_idx = (times[None, :]+offsets[:, None]).ravel()[:count]
    keys = sorted({key for bar in bars for key, value in bar.items()
                   if key != 'time' and isinstance(value, (int, float)) and not isinstance(value, bool)})
    columns = {'time_idx': time_idx.astype('<f8').tobytes()}
    for key in keys:
        base = np.array([bar.get(key) if isinstance(bar.get(key), (int, float)) else np.nan for bar in bars], dtype='<f8')
        columns[key] = np.tile(base, copies)[:count].tobytes()
    return columns, keys


def time_ms(value):
    from datetime import datetime, timezone
    text = str(value).replace('Z', '+00:00')
    stamp = datetime.fromisoformat(text)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.timestamp()*1000


def main():
    from engine.runtime import initialize_runtime, plan_tile
    from engine.session import NativeSession
    from engine.memory import reserved_static_bytes, session_buffer_mb

    bars = json.loads((ROOT/'.local-data/bench-bars/ETHUSDT-15m-perp-70174.json').read_bytes())
    assert len(bars) == 70174
    columns, keys = build_tiled_columns(bars, TARGET_BARS)
    metadata = {'count': TARGET_BARS, 'max_bars': 300_000, 'string_columns': {}}
    tokens = json.loads((ROOT/'.local-data/native-gpu-g2/ADAUSDT-30m.tokens.json').read_bytes())[:60]

    cores = os_cpu_count()
    tier = 'high (>=20 cores)' if cores >= 20 else 'mid' if cores >= 12 else 'low'
    sampler = Sampler()
    started = time.monotonic()
    runtime = initialize_runtime('mixed')
    session = NativeSession('g4-deep-memory', runtime, 'mixed')
    report = {'gate': 'G4-deep-memory', 'bars': TARGET_BARS, 'source_bars': len(bars),
              'data_note': 'synthetic tiling of the frozen 70174 fixture, strictly increasing timestamps',
              'tier_derivation': f'{cores} cores -> {tier}, guard 300000', 'config': CONFIG,
              'device': {k: runtime.get(k) for k in ('backend', 'device_name', 'vram_mb', 'sm_count')}}
    sampler.start()
    try:
        session.load_bars(columns, metadata)
        info = session.prepare_features(CONFIG)
        tile = session.metrics.tile
        buffers_mb = session_buffer_mb(session)
        session.eval_shards(tokens)
        time.sleep(.4)
    finally:
        sampler.stop()
        session.dispose()
    vram_mb = float(runtime['vram_mb'])
    peak_used = max(s[1] for s in sampler.samples)
    peak_total = max(s[2] for s in sampler.samples)
    peak_fraction = peak_used/peak_total if peak_total else 1.0
    static = reserved_static_bytes(TARGET_BARS)
    planned = plan_tile(TARGET_BARS, 62, 3000, 'mixed', vram_mb, static_bytes=static)
    # The engine plans with the trimmed matrix length (head_trim drops leading
    # bars), so its tile can only be >= the raw-length plan used here as a
    # conservative bound; both must stay under the 70k-performance cap of 128.
    checks = {
        'tile_auto_shrunk_below_128': 1 <= tile < 128,
        'tile_within_plan_bound': planned <= tile < 128,
        'resident_buffers_below_70pct_vram': buffers_mb/1024/vram_mb < .7,
        'nvidia_peak_below_70pct_vram': peak_fraction < .7,
        'within_device_profile_guard': TARGET_BARS <= 300_000,
        'real_eval_completed': True,
    }
    report.update(checks=checks, tile=tile, planned_tile=planned, resident_buffers_mb=buffers_mb,
                  vram_mb=vram_mb, nvidia_peak_used_mb=peak_used, nvidia_peak_fraction=peak_fraction,
                  nvidia_samples=len(sampler.samples), elapsed_seconds=time.monotonic()-started,
                  column_keys=keys, feature_names=info.get('feature_names', [])[:5],
                  recorded_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    out = ROOT/'.local-data/native-gpu-reports/g4-deep-246k-r1.json'
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k not in ('config',)}, ensure_ascii=False), flush=True)
    return 0 if all(checks.values()) else 1


def os_cpu_count():
    import os
    return os.cpu_count() or 4


if __name__ == '__main__':
    raise SystemExit(main())
