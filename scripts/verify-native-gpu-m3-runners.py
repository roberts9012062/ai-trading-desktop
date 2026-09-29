"""Real two-runner IPC/factory/IDB tests with a disclosed desktop-command adapter.

The adapter supervises real native subprocesses. Rust handshake/lifecycle tests
are a separate gate; this harness does not claim a packaged desktop test.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_bench', ROOT/'scripts/bench-native-gpu.py')
BENCH = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BENCH)


class Controller:
    def __init__(self, python, fault, out, runtime_loss=False):
        self.python, self.fault, self.out = python, fault, out
        self.runtime_loss = runtime_loss
        self.process = self.endpoint = self.error_log = None
        self.reader = ThreadPoolExecutor(max_workers=1)
        self.starts, self.kills = 0, 0
        self.marker = out.with_suffix('.driver-marker')
        self.marker.unlink(missing_ok=True)

    def invoke(self, command, arguments=None):
        if command == 'native_engine_kill':
            self.stop(); return None
        if command == 'native_engine_status':
            alive = self.process is not None and self.process.poll() is None
            return {'running': alive, 'ready': alive and self.endpoint is not None}
        if command != 'native_engine_spawn':
            raise RuntimeError(f'Unexpected desktop command {command}')
        if self.process is not None and self.process.poll() is None and self.endpoint is not None:
            return self.endpoint
        self.stop()
        self.marker.unlink(missing_ok=True)
        self.starts += 1
        self.error_log = self.out.with_suffix(f'.startup-{self.starts}.stderr.log').open('w', encoding='utf-8')
        precision = (arguments or {}).get('precision', 'mixed')
        command = [str(self.python), '-u', str(ROOT/'scripts/native-gpu-injected-sidecar.py'), '--precision', precision, '--fault', self.fault]
        if self.runtime_loss: command += ['--driver-marker', str(self.marker)]
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        started = time.monotonic()
        self.process = subprocess.Popen(command, cwd=ROOT, env={**os.environ, 'PYTHONPATH': str(ROOT/'native-engine')},
            stdout=subprocess.PIPE, stderr=self.error_log, text=True, encoding='utf-8', **kwargs)
        try:
            self.endpoint = self.reader.submit(BENCH.ready_record, self.process).result(timeout=BENCH.STARTUP_TIMEOUT_SECONDS)
            self.endpoint['pid'] = self.process.pid
            print(f'native-runner-process ready #{self.starts} {time.monotonic()-started:.3f}s', flush=True)
            return self.endpoint
        except Exception as error:
            self.stop()
            names = {'no-driver': 'NVIDIA 驱动不可用', 'no-card': 'NVIDIA CUDA 设备缺失', 'selfcheck': 'G1 确定性自检失败'}
            raise RuntimeError(f"{names.get(self.fault, '原生进程启动失败')}（故障注入：{error}）") from error

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill(); self.process.wait(timeout=15)
            if self.process.stdout: self.process.stdout.close()
        self.process = self.endpoint = None
        if self.error_log is not None: self.error_log.close()
        self.error_log = None

    def inject(self, request):
        self.kills += 1
        print(f'native-runner-fault {request} #{self.kills}', flush=True)
        if self.runtime_loss: self.marker.write_text('injected driver loss', encoding='utf-8')
        else: self.stop()

    def close(self):
        self.stop(); self.reader.shutdown(wait=True, cancel_futures=True)
        self.marker.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--mode', choices=('complete', 'kill', 'fallback', 'driver', 'queue'), default='complete')
    parser.add_argument('--fault', choices=('none', 'no-driver', 'no-card', 'selfcheck'), default='none')
    parser.add_argument('--force-cpu', action='store_true')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--native-python', type=Path, default=ROOT/'.local-data/native-engine-venv/Scripts/python.exe')
    args = parser.parse_args()
    fixture = ROOT/'.local-data/native-gpu-g2'
    encoded = (fixture/'ETHUSDT-15m.bars.json').read_bytes()
    bars = json.loads(encoded)
    config = json.loads((fixture/'ETHUSDT-15m.config.json').read_text(encoding='utf-8'))
    if args.mode in ('fallback', 'driver', 'queue'):
        bars = bars[:2049]; config = {**config, 'population': 20, 'max_depth': 4}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    controller = Controller(args.native_python, args.fault, args.out, args.mode == 'driver')
    started = time.monotonic()
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='chrome', headless=True, args=['--enable-unsafe-webgpu', '--use-angle=d3d11'])
            try:
                page = browser.new_page()
                page.expose_function('nativeTestInvoke', controller.invoke)
                page.expose_function('nativeTestFault', controller.inject)
                page.expose_function('nativeTestStats', lambda: {'starts': controller.starts, 'kills': controller.kills})
                page.add_init_script("window.isTauri = true; window.__TAURI_INTERNALS__ = {invoke: (command, args) => window.nativeTestInvoke(command, args)}")
                if args.force_cpu: page.add_init_script("Object.defineProperty(navigator, 'gpu', {value: undefined, configurable: true})")
                page.goto(args.url.rstrip('/')+'/scripts/native-gpu-m3.html', wait_until='networkidle')
                page.wait_for_function("typeof window.nativeRunnerVerification === 'function'")
                if args.mode == 'queue':
                    page.wait_for_function("typeof window.nativeQueueVerification === 'function'")
                    result = page.evaluate('async input => await window.nativeQueueVerification(input)', {'bars': bars, 'config': config})
                else:
                    result = page.evaluate('async input => await window.nativeRunnerVerification(input)', {'bars': bars, 'config': config, 'mode': args.mode})
            finally: browser.close()
        result.update(mode=args.mode, fault=args.fault, force_cpu=args.force_cpu, elapsed_seconds=time.monotonic()-started,
                      command_adapter='Python supervision of real sidecars; Rust tested separately',
                      real_bars=len(bars), fixture_sha256=hashlib.sha256(encoded).hexdigest(), process_starts=controller.starts,
                      injected_events=controller.kills, G5_eight_hours_complete=False)
        for row in result.get('results', []):
            task = row['task']
            actual = task.get('engine') if row['entrance'] == 'lab' else task.get('actualEngine')
            if args.mode in ('complete', 'kill'): result['passed'] &= actual == 'native-gpu'
            if args.mode in ('fallback', 'driver'):
                result['passed'] &= actual in ('gpu', 'cpu') and (not args.force_cpu or actual == 'cpu')
                result['passed'] &= any('WebGPU' in str(event.get('phase') or event.get('pause_reason') or '') for event in row['events'])
        if args.mode == 'queue':
            result['passed'] &= result.get('startsFinal') == 2 and result.get('startsWhileShared') == 1
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        print(json.dumps({key: value for key, value in result.items() if key != 'results'}, ensure_ascii=False), flush=True)
        return int(not result['passed'])
    finally: controller.close()


if __name__ == '__main__':
    raise SystemExit(main())
