"""Real NativeGpuBackend IPC/direct entrance, generation pause and disposal.

This diagnoses new M3 files; it does not certify two-runner wiring/G5/G6.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_bench', ROOT/'scripts/bench-native-gpu.py')
BENCH = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BENCH)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--suite', type=Path, default=ROOT/'.local-data/native-gpu-g2/suite.json')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--native-python', type=Path, default=ROOT/'.local-data/native-engine-venv/Scripts/python.exe')
    args = parser.parse_args()
    manifest = json.loads(args.suite.read_text(encoding='utf-8'))
    case = next(case for case in manifest['cases'] if case['symbol'] == 'ETHUSDT' and case['timeframe'] == '15m')
    base = args.suite.parent
    bars_bytes = (base/case['bars']).read_bytes()
    bars = json.loads(bars_bytes)
    config = json.loads((base/case['config']).read_text(encoding='utf-8'))
    cpu = json.loads((base/case['cpu_reference']).read_text(encoding='utf-8'))
    from playwright.sync_api import sync_playwright
    reader = ThreadPoolExecutor(max_workers=1)
    process = None
    args.out.parent.mkdir(parents=True, exist_ok=True)
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    with args.out.with_suffix('.stderr.log').open('w', encoding='utf-8') as error_log:
        try:
            started = time.monotonic()
            process = subprocess.Popen([str(args.native_python), '-u', '-m', 'engine', '--precision', 'mixed'],
                cwd=ROOT, env={**os.environ, 'PYTHONPATH': str(ROOT/'native-engine')},
                stdout=subprocess.PIPE, stderr=error_log, text=True, encoding='utf-8', **kwargs)
            endpoint = reader.submit(BENCH.ready_record, process).result(timeout=BENCH.STARTUP_TIMEOUT_SECONDS)
            endpoint['pid'] = process.pid
            print(f'G1 ready after {time.monotonic()-started:.3f}s', flush=True)
            with sync_playwright() as pw:
                browser = pw.chromium.launch(channel='chrome', headless=True)
                try:
                    page = browser.new_page()
                    page.on('console', lambda msg: print(msg.text, flush=True) if msg.text.startswith('native-m3-stage') else None)
                    page.goto(args.url.rstrip('/')+'/scripts/native-gpu-m3.html', wait_until='networkidle')
                    page.wait_for_function("typeof window.verifyNativeM3 === 'function'")
                    result = page.evaluate('async input => await window.verifyNativeM3(input)',
                        {'endpoint': endpoint, 'bars': bars, 'config': config, 'precision': 'mixed'})
                finally:
                    browser.close()
            # Real IPC's initial authority is compared against the frozen CPU
            # input batch; later D-1/evolution tokens are a different population.
            reference = {tuple(row['tokens']): row['composite'] for row in cpu['outputs']['evaluated']}
            checked, failures = 0, []
            for report in result['reports']:
                for row in report['steps'][0]['bestSeen']:
                    key, value = tuple(row['tokens']), float(row['composite'])
                    if key not in reference:
                        failures.append({'tokens': key, 'reason': 'initial population differs'})
                        continue
                    expected = float(reference[key])
                    relative = abs(value-expected)/abs(expected) if expected else (0 if value == 0 else float('inf'))
                    checked += 1
                    if relative >= 1e-9:
                        failures.append({'tokens': key, 'native': value, 'cpu': expected})
            result.update(initial_authority_checked=checked, initial_authority_failures=failures,
                          bars_sha256=hashlib.sha256(bars_bytes).hexdigest(),
                          engine_version=endpoint['hello']['engine_version'],
                          integration_complete=False)
            result['passed'] = result['passed'] and checked > 0 and not failures
            args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
            print(json.dumps({'gate': 'M3-core', 'passed': result['passed'], 'initial_authority_checked': checked,
                'initial_authority_failures': failures, 'modes': [(r['mode'],r['passed']) for r in result['reports']]}), flush=True)
            return int(not result['passed'])
        finally:
            if process and process.poll() is None:
                process.kill(); process.wait(timeout=15)
            reader.shutdown(wait=True, cancel_futures=True)


if __name__ == '__main__':
    raise SystemExit(main())
