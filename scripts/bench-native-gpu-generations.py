"""G3 core via unchanged JS evolution, real sidecar IPC and nvidia-smi.

An explicit shorter run is diagnostic only. G3 requires all 100 generations
<=5000ms (product amendment 2026-09-29) and time-weighted utilization >=60%
over the complete mining loop.
Startup, transfer, features and kernel warmup are recorded separately.
"""
import argparse
import csv
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native-engine'))
SPEC = importlib.util.spec_from_file_location('native_bench', ROOT/'scripts/bench-native-gpu.py')
BENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCH)


def sampling_summary(path, start_ms, end_ms):
    samples = []
    for row in csv.reader(path.read_text(encoding='utf-8').splitlines()):
        if len(row) != 5:
            continue
        try:
            stamp = datetime.strptime(row[0].strip(), '%Y/%m/%d %H:%M:%S.%f').timestamp()*1000
            samples.append((stamp, int(row[2].strip()), int(row[3].strip()), int(row[4].strip())))
        except ValueError:
            continue
    if not samples:
        raise ValueError('Missing real nvidia-smi GPU samples')
    weighted = duration = 0.0
    for first, second in zip(samples, samples[1:]):
        overlap = max(0.0, min(end_ms, second[0])-max(start_ms, first[0]))
        weighted += overlap*first[1]
        duration += overlap
    coverage = duration/(end_ms-start_ms) if end_ms > start_ms else 0.0
    during = [sample for sample in samples if start_ms <= sample[0] <= end_ms]
    return {'sampling_ms': 200, 'sample_count': len(during), 'coverage': coverage,
            'utilization_time_weighted_percent': weighted/duration if duration else 0.0,
            'vram_peak_mb': max((sample[2] for sample in during), default=0),
            'vram_peak_fraction': max((sample[2]/sample[3] for sample in during), default=0.0)}


def acceptance(result, sampling):
    rows = result.get('generations', [])
    complete = (result.get('bars') == 70174 and result.get('config', {}).get('population') == 3000
                and result.get('config', {}).get('generations') == 100 and len(rows) == 100
                and [row['generation'] for row in rows] == list(range(1, 101)))
    timings = bool(rows) and all(row['elapsedMs'] <= 5000 for row in rows)
    utilization = (sampling['coverage'] >= .99 and sampling['sample_count'] >= 10
                   and sampling['utilization_time_weighted_percent'] >= 60)
    from engine.qualification import qualify_candidates
    requirements, research = result.get('qualification_requirements'), result.get('research_candidates')
    quality = False
    if isinstance(requirements, dict) and isinstance(research, list):
        expected = qualify_candidates(research, requirements, final_generation=True)
        quality = (requirements.get('wf_folds', 0) == int(result.get('config', {}).get('walk_forward_folds') or 0)
                   and result.get('champions') == expected['champions']
                   and result.get('pending_candidates') == expected['pending']
                   and result.get('rejected_candidates') == expected['rejected'])
    return {'complete_scenario': complete, 'every_generation_le_5000ms': timings,
            'sustained_gpu_ge_60pct': utilization, 'champion_qualification_valid': quality,
            'vram_peak_below_70pct': sampling['vram_peak_fraction'] < .7,
            'passed': complete and timings and utilization and quality and sampling['vram_peak_fraction'] < .7}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--bars', type=Path, required=True)
    parser.add_argument('--precision', choices=('mixed', 'f64'), default='mixed')
    parser.add_argument('--generations', type=int, default=100)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--native-python', type=Path, default=ROOT/'.local-data/native-engine-venv/Scripts/python.exe')
    args = parser.parse_args()
    if not 1 <= args.generations <= 100:
        parser.error('Generations must be 1..100; only 100 can certify G3')
    encoded = args.bars.read_bytes()
    bars = json.loads(encoded)
    config = {'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True, 'population': 3000,
              'generations': args.generations, 'max_depth': 6, 'seed': 42, 'train_ratio': .7,
              'test_recent_bars': 0, 'walk_forward_folds': 3, 'cost': .0003, 'top_n': 10,
              'research_profile': 'crypto_ohlcv_v1', 'execution_model': 'signal_research', 'selection_v2': True}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    samples_path = args.out.with_suffix('.gpu.csv')
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    sidecar = sampler = None
    reader = ThreadPoolExecutor(max_workers=1)
    start = time.monotonic()
    with args.out.with_suffix('.stderr.log').open('w', encoding='utf-8') as error_log, samples_path.open('w', encoding='utf-8') as samples:
        try:
            sidecar = subprocess.Popen([str(args.native_python), '-u', '-m', 'engine', '--precision', args.precision],
                cwd=ROOT, env={**os.environ, 'PYTHONPATH': str(ROOT/'native-engine')},
                stdout=subprocess.PIPE, stderr=error_log, text=True, encoding='utf-8', **kwargs)
            endpoint = reader.submit(BENCH.ready_record, sidecar).result(timeout=BENCH.STARTUP_TIMEOUT_SECONDS)
            endpoint['pid'] = sidecar.pid
            startup_seconds = time.monotonic()-start
            print(f'G1 passed in {startup_seconds:.3f}s; starting G3 core', flush=True)
            sampler = subprocess.Popen(['nvidia-smi', '--query-gpu=timestamp,index,utilization.gpu,memory.used,memory.total',
                '--format=csv,noheader,nounits', '-lms', '200'], stdout=samples, stderr=error_log, **kwargs)
            from playwright.sync_api import sync_playwright
            with sync_playwright() as pw:
                browser = pw.chromium.launch(channel='chrome', headless=True)
                try:
                    page = browser.new_page()
                    page.on('console', lambda msg: print(msg.text, flush=True) if msg.text.startswith('native-generation-stage') else None)
                    page.on('pageerror', lambda exc: print(f'browser error: {exc}', file=sys.stderr, flush=True))
                    page.goto(args.url.rstrip('/')+'/scripts/native-gpu-generations.html', wait_until='networkidle')
                    page.wait_for_function("typeof window.benchmarkNativeGenerations === 'function'")
                    result = page.evaluate('async input => await window.benchmarkNativeGenerations(input)',
                                           {'endpoint': endpoint, 'bars': bars, 'config': config})
                finally:
                    browser.close()
            # Obtain one post-loop sample to close the last weighting interval.
            time.sleep(.3)
            sampler.kill(); sampler.wait(timeout=15); sampler = None
            samples.flush()
            summary = sampling_summary(samples_path, result['miningStartMs'], result['miningEndMs'])
            gates = acceptance(result, summary)
            result.update(startup_seconds=startup_seconds, sampling=summary, acceptance=gates,
                          G3_complete=gates['passed'], passed=gates['passed'],
                          bars_sha256=hashlib.sha256(encoded).hexdigest(),
                          recorded_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
            args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
            print(json.dumps({'gate': 'G3', 'precision': args.precision, 'acceptance': gates, 'sampling': summary}), flush=True)
            return int(not gates['passed'])
        except Exception as exc:
            args.out.write_text(json.dumps({'gate': 'G3', 'G3_complete': False, 'passed': False,
                                           'error': str(exc), 'config': config, 'precision': args.precision},
                                          ensure_ascii=False, indent=2), encoding='utf-8')
            raise
        finally:
            for process in (sampler, sidecar):
                if process and process.poll() is None:
                    process.kill(); process.wait(timeout=15)
            reader.shutdown(wait=True, cancel_futures=True)


if __name__ == '__main__':
    raise SystemExit(main())
