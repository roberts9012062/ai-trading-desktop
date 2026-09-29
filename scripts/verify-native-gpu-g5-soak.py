"""G5 eight-hour soak controller (docs/plans/2026-09-29-native-gpu-m3-soak.md).

Drives the real default factory path in a real browser page: both entrances,
real sidecar subprocesses, IndexedDB persistence. Samples nvidia-smi at 200ms
and sidecar/system memory at 5s, checkpoints every cycle, rechecks the frozen
champion qualification gate in Python and the native source SHA at the end.

Short runs (--minutes) are script diagnostics only and never certify G5.
"""
import argparse
import csv
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native-engine'))
SPEC = importlib.util.spec_from_file_location('native_bench', ROOT/'scripts/bench-native-gpu.py')
BENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCH)
G3 = importlib.util.spec_from_file_location('native_g3', ROOT/'scripts/bench-native-gpu-generations.py')
G3 = importlib.util.module_from_spec(G3)
G3.__loader__.exec_module(G3)

G3_CONFIG = {'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True, 'population': 3000,
             'generations': 100, 'max_depth': 6, 'seed': 42, 'train_ratio': .7,
             'test_recent_bars': 0, 'walk_forward_folds': 3, 'cost': .0003, 'top_n': 10,
             'research_profile': 'crypto_ohlcv_v1', 'execution_model': 'signal_research', 'selection_v2': True}

import psutil


def sidecar_rss_mb(pid):
    # The venv python is a uv trampoline launcher: real memory sits in its
    # children, so report the whole process tree's resident set.
    try:
        proc = psutil.Process(int(pid))
        total = proc.memory_info().rss + sum(child.memory_info().rss for child in proc.children(recursive=True))
        return round(total/1048576, 3)
    except Exception:
        return None


def system_avail_mb():
    try:
        return round(psutil.virtual_memory().available/1048576, 3)
    except Exception:
        return None


def native_source_sha():
    sha = hashlib.sha256()
    for path in sorted((ROOT/'native-engine').rglob('*.py')):
        sha.update(str(path.relative_to(ROOT)).replace('\\', '/').encode())
        sha.update(path.read_bytes())
    sha.update(b'VERSION')
    sha.update((ROOT/'native-engine/VERSION').read_bytes())
    return sha.hexdigest()


class MemorySampler(threading.Thread):
    def __init__(self, path, controller):
        super().__init__(daemon=True)
        self.path, self.controller = path, controller
        self.rows = []
        self._halt = threading.Event()

    def run(self):
        with self.path.open('w', encoding='utf-8', newline='') as out:
            writer = csv.writer(out)
            writer.writerow(['wall_ms', 'sidecar_pid', 'sidecar_rss_mb', 'system_avail_mb'])
            while not self._halt.is_set():
                process = self.controller.process
                pid = process.pid if process is not None else ''
                rss = sidecar_rss_mb(pid) if pid else None
                avail = system_avail_mb()
                wall = round(time.time()*1000)
                self.rows.append((wall, rss, avail))
                writer.writerow([wall, pid, '' if rss is None else rss, '' if avail is None else avail])
                out.flush()
                self._halt.wait(5)

    def stop(self):
        self._halt.set()
        self.join(timeout=15)

    def summary(self):
        if not self.rows:
            return {'sample_interval_s': 5, 'samples': 0}
        rss = [row[1] for row in self.rows if row[1] is not None]
        avail = [row[2] for row in self.rows if row[2] is not None]
        summary = {'sample_interval_s': 5, 'samples': len(self.rows)}
        if rss:
            summary.update({'sidecar_rss_peak_mb': max(rss), 'sidecar_rss_first_mb': rss[0], 'sidecar_rss_last_mb': rss[-1]})
        if avail:
            summary['system_avail_min_mb'] = min(avail)
        return summary


class SoakController:
    """Python supervision adapter: one shared real sidecar across all cycles."""

    def __init__(self, python, out):
        self.python, self.out = python, out
        self.process = self.endpoint = self.error_log = None
        self.reader = ThreadPoolExecutor(max_workers=1)
        self.starts = 0
        self.unexpected_exits = 0

    def invoke(self, command, arguments=None):
        if command == 'native_engine_kill':
            self.stop()
            return None
        if command == 'native_engine_status':
            alive = self.process is not None and self.process.poll() is None
            return {'running': alive, 'ready': alive and self.endpoint is not None}
        if command != 'native_engine_spawn':
            raise RuntimeError(f'Unexpected desktop command {command}')
        if self.process is not None and self.process.poll() is None and self.endpoint is not None:
            return self.endpoint
        if self.process is not None:
            # A previous sidecar died without an explicit kill: G5 must see this.
            self.unexpected_exits += 1
        self.stop()
        self.starts += 1
        self.error_log = self.out.with_suffix(f'.sidecar-{self.starts}.stderr.log').open('w', encoding='utf-8')
        precision = (arguments or {}).get('precision', 'mixed')
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        command = [str(self.python), '-u', '-m', 'engine', '--precision', precision]
        started = time.monotonic()
        self.process = subprocess.Popen(command, cwd=ROOT, env={**os.environ, 'PYTHONPATH': str(ROOT/'native-engine')},
                                        stdout=subprocess.PIPE, stderr=self.error_log, text=True, encoding='utf-8', **kwargs)
        try:
            self.endpoint = self.reader.submit(BENCH.ready_record, self.process).result(timeout=BENCH.STARTUP_TIMEOUT_SECONDS)
            self.endpoint['pid'] = self.process.pid
            print(f'soak-sidecar ready #{self.starts} in {time.monotonic()-started:.3f}s pid {self.process.pid}', flush=True)
            return self.endpoint
        except Exception as error:
            self.stop()
            raise RuntimeError(f'原生进程启动失败：{error}') from error

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=15)
            if self.process.stdout:
                self.process.stdout.close()
        self.process = self.endpoint = None
        if self.error_log is not None:
            self.error_log.close()
        self.error_log = None

    def close(self):
        self.stop()
        self.reader.shutdown(wait=True, cancel_futures=True)


def qualification_recheck(record, engine_version):
    """Independent Python recheck of the frozen gate for every published champion."""
    from engine.qualification import qualify_candidates
    checked = 0
    for row in record.get('qualification', []):
        candidate, requirements = row['candidate'], row['requirements']
        gate = qualify_candidates([candidate], requirements, final_generation=True)
        metrics = candidate.get('metrics', {})
        origin = (metrics.get('kernel_version') == 'native-gpu-v1'
                  and metrics.get('native_engine_version') == engine_version
                  and metrics.get('native_eval_precision') == 'f64')
        if len(gate['champions']) != 1 or not origin:
            return False, f"cycle {record.get('cycle')} champion failed the Python gate or origin"
        checked += 1
    return True, f'{checked} champions rechecked'


def acceptance(result, target_seconds, controller, source_ok, gate_ok, gate_note):
    cycles = result.get('cycles', [])
    entrances = {row['entrance'] for row in cycles}
    complete = all(row.get('generations') == 100 for row in cycles) and len(cycles) >= 2
    return {
        'reached_target_mining_seconds': result.get('miningSeconds', 0) >= target_seconds,
        'both_entrances_completed': entrances == {'lab', 'super'},
        'every_task_100_generations': complete,
        'single_shared_process': controller.starts == 1 and controller.unexpected_exits == 0,
        'native_source_unchanged': source_ok,
        'champion_gate_recheck': gate_ok,
        'champion_gate_note': gate_note,
        'passed': bool(result.get('miningSeconds', 0) >= target_seconds and entrances == {'lab', 'super'}
                       and complete and controller.starts == 1 and controller.unexpected_exits == 0
                       and source_ok and gate_ok),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--hours', type=float, default=8.0, help='target cumulative generation-compute hours')
    parser.add_argument('--minutes', type=float, default=None, help='diagnostic short run (never certifies G5)')
    parser.add_argument('--bars', type=Path, default=ROOT/'.local-data/bench-bars/ETHUSDT-15m-perp-70174.json')
    parser.add_argument('--native-python', type=Path, default=ROOT/'.local-data/native-engine-venv/Scripts/python.exe')
    parser.add_argument('--cycle-timeout-seconds', type=int, default=2700)
    args = parser.parse_args()
    target_seconds = (args.minutes*60 if args.minutes is not None else args.hours*3600)
    encoded = args.bars.read_bytes()
    bars = json.loads(encoded)
    if len(bars) != 70174:
        parser.error(f'G5 requires the frozen 70174-bar fixture, got {len(bars)}')
    engine_version = (ROOT/'native-engine/VERSION').read_text(encoding='utf-8').strip()
    source_start = native_source_sha()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    progress_path = args.out.with_suffix('.progress.jsonl')
    controller = SoakController(args.native_python, args.out)
    memory = MemorySampler(args.out.with_suffix('.memory.csv'), controller)
    gpu_csv = args.out.with_suffix('.gpu.csv')
    state = {'records': [], 'done': False, 'summary': None, 'generations': 0}
    progress_lock = threading.Lock()

    def on_progress(record):
        with progress_lock:
            with progress_path.open('a', encoding='utf-8') as log:
                log.write(json.dumps(record, ensure_ascii=False, separators=(',', ':'))+'\n')
        kind = record.get('type')
        if kind == 'generation':
            state['generations'] += 1
            if record['generation'] % 10 == 0 or record['generation'] == 1:
                print(f"soak {record['entrance']} cycle {record['cycle']} gen {record['generation']}/100 "
                      f"{record['elapsedMs']}ms cumulative {record['miningSeconds']:.0f}s", flush=True)
        elif kind == 'cycle':
            state['records'].append(record)
            print(f"soak CYCLE done {record['entrance']} #{record['cycle']} gens {record['generations']} "
                  f"champions {record['champions']} cumulative {record['cumulativeMiningSeconds']:.0f}s "
                  f"maxGen {record['maxGenerationMs']}ms", flush=True)
        return None

    started = time.monotonic()
    gpu = None
    try:
        gpu = subprocess.Popen(['nvidia-smi', '--query-gpu=timestamp,index,utilization.gpu,memory.used,memory.total',
                                '--format=csv,noheader,nounits', '-lms', '200'], stdout=gpu_csv.open('w', encoding='utf-8'),
                               stderr=subprocess.DEVNULL, **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
        memory.start()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='chrome', headless=True)
            try:
                page = browser.new_page()
                page.set_default_timeout(args.cycle_timeout_seconds*1000)
                page.expose_function('nativeTestInvoke', controller.invoke)
                page.expose_function('nativeSoakProgress', on_progress)
                page.add_init_script("window.isTauri = true; window.__TAURI_INTERNALS__ = {invoke: (command, args) => window.nativeTestInvoke(command, args)}")
                page.on('pageerror', lambda exc: print(f'browser error: {exc}', file=sys.stderr, flush=True))
                page.goto(args.url.rstrip('/')+'/scripts/native-gpu-soak.html', wait_until='networkidle')
                page.wait_for_function("typeof window.nativeSoakNext === 'function'")
                payload = {'bars': bars, 'config': G3_CONFIG, 'targetMiningSeconds': target_seconds}
                first = True
                while True:
                    call = page.evaluate('async input => await window.nativeSoakNext(input)',
                                         payload if first else None)
                    first = False
                    if call.get('done'):
                        state['done'] = True
                        state['summary'] = call.get('summary')
                        break
                    # Cycle checkpoint: the report is inspectable even if the run dies here.
                    args.out.with_suffix('.checkpoint.json').write_text(json.dumps(
                        {'elapsed_seconds': time.monotonic()-started, 'records': state['records'],
                         'generations': state['generations'], 'process_starts': controller.starts,
                         'target_seconds': target_seconds}, ensure_ascii=False, indent=2), encoding='utf-8')
            finally:
                browser.close()
        time.sleep(.3)
        gpu.kill(); gpu.wait(timeout=15); gpu = None
        memory.stop()
        result = state['summary'] or {}
        gate_ok, gate_note = True, 'no champions published'
        for record in state['records']:
            gate_ok, gate_note = qualification_recheck(record, engine_version)
            if not gate_ok:
                break
        source_ok = native_source_sha() == source_start
        summary = result.get('miningStartMs') and G3.sampling_summary(gpu_csv, result['miningStartMs'], result['miningEndMs'])
        gates = acceptance(result, target_seconds, controller, source_ok, gate_ok, gate_note)
        report = {**result, 'gate': 'G5-soak', 'target_seconds': target_seconds, 'acceptance': gates,
                  'passed': gates['passed'] and state['done'],
                  'G5_eight_hours_complete': gates['passed'] and state['done'] and result.get('miningSeconds', 0) >= 28800,
                  'diagnostic_short_run': args.minutes is not None,
                  'gpu_sampling': summary, 'memory_sampling': memory.summary(),
                  'process_starts': controller.starts, 'unexpected_sidecar_exits': controller.unexpected_exits,
                  'native_source_sha256_start': source_start, 'native_source_sha256_end': native_source_sha(),
                  'bars_sha256': hashlib.sha256(encoded).hexdigest(), 'engine_version': engine_version,
                  'wall_seconds': time.monotonic()-started,
                  'command_adapter': 'Python supervision of real sidecars; not a packaged desktop test',
                  'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        print(json.dumps({key: value for key, value in report.items() if key != 'cycles'}, ensure_ascii=False), flush=True)
        return 0 if report['passed'] else 1
    except Exception as exc:
        memory.stop()
        if gpu is not None and gpu.poll() is None:
            gpu.kill(); gpu.wait(timeout=15)
        args.out.write_text(json.dumps({'gate': 'G5-soak', 'passed': False, 'G5_eight_hours_complete': False,
                                        'error': str(exc), 'elapsed_seconds': time.monotonic()-started,
                                        'records': state['records'], 'generations': state['generations'],
                                        'process_starts': controller.starts,
                                        'unexpected_sidecar_exits': controller.unexpected_exits,
                                        'native_source_sha256_start': source_start,
                                        'native_source_sha256_end': native_source_sha(),
                                        'engine_version': engine_version,
                                        'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                                       ensure_ascii=False, indent=2), encoding='utf-8')
        raise
    finally:
        controller.close()


if __name__ == '__main__':
    raise SystemExit(main())
