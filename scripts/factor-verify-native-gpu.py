"""原生 GPU 产品路径验证:真实引擎 sidecar + 真实前端 runner(m3 桥接)。

与 verify-native-gpu-m3-runners.py 同一套 disclosed adapter(浏览器内跑真实
FactorLabSearchRunner,Python 监管真实原生子进程),但:
- bars/config 从 .local-data/factor-verify/ 读(全周期新鲜数据);
- config 带冠军种子(seed_tokens)+ 增强挖掘 + v2 档案(产品默认口径);
- 断言 champions 的合格性(qualification.status=qualified)而非只看 completed。

用法(先构建并起 preview 服务):
  npx vite build --config scripts/native-gpu-m3.vite.config.ts
  npx vite preview --host 127.0.0.1 --port 4210 --strictPort
  python scripts/factor-verify-native-gpu.py --url http://127.0.0.1:4210 \
      --symbol BTCUSDT --tf 30m --population 600 --generations 40 \
      --out .local-data/factor-verify/native-btc-30m.json
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location('native_bench', ROOT / 'scripts/bench-native-gpu.py')
BENCH = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BENCH)

_SEED_LIB_PATH = Path(__file__).resolve().parents[1] / ".local-data/factor-verify/champion-seeds.json"


def champion_seed_tokens(symbol: str, timeframe: str) -> list[list[int]]:
    """与 src/lib/mining/champion-seeds.ts championSeedsFor 同口径:
    精确(币+周期) > 同周期跨币(去重) > 全库(跨周期族迁移,去重)。"""
    lib = json.loads(_SEED_LIB_PATH.read_text(encoding="utf-8"))
    exact = [s for s in lib if s["symbol"] == symbol and s["timeframe"] == timeframe]
    pool = exact
    if not pool:
        pool = [s for s in lib if s["timeframe"] == timeframe]
    if not pool:
        pool = lib
    seen, out = set(), []
    for s in pool:
        key = tuple(s["tokens"])
        if key not in seen:
            seen.add(key)
            out.append(s["tokens"])
    return out


class Controller:
    """与 m3 验证同款:spawn 真实原生引擎子进程并读 ready 行。"""

    def __init__(self, python, out):
        self.python, self.out = python, out
        self.process = self.endpoint = self.error_log = None
        self.reader = ThreadPoolExecutor(max_workers=1)
        self.starts = 0

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
        self.stop()
        self.starts += 1
        self.error_log = self.out.with_suffix(f'.native-{self.starts}.stderr.log').open('w', encoding='utf-8')
        precision = (arguments or {}).get('precision', 'mixed')
        import os
        cmd = [str(self.python), '-u', str(ROOT / 'scripts/native-gpu-injected-sidecar.py'),
               '--precision', precision, '--fault', 'none']
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
        started = time.monotonic()
        self.process = subprocess.Popen(
            cmd, cwd=ROOT,
            env={**os.environ, 'PYTHONPATH': str(ROOT / 'native-engine') + (';' if sys.platform == 'win32' else ':') + str(ROOT / 'public' / 'pykernel')},
            stdout=subprocess.PIPE, stderr=self.error_log, text=True, encoding='utf-8', **kwargs)
        try:
            self.endpoint = self.reader.submit(BENCH.ready_record, self.process).result(timeout=3600)  # 冷 JIT(50系compat)可达数十分钟,不沿用 300s
            self.endpoint['pid'] = self.process.pid
            print(f'native engine ready #{self.starts} in {time.monotonic()-started:.0f}s', flush=True)
            return self.endpoint
        except Exception as error:
            self.stop()
            raise RuntimeError(f'原生进程启动失败: {error}') from error

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--symbol', default='BTCUSDT')
    parser.add_argument('--tf', default='30m')
    parser.add_argument('--population', type=int, default=600)
    parser.add_argument('--generations', type=int, default=40)
    parser.add_argument('--no-seeds', action='store_true')
    parser.add_argument('--precision', default='mixed', choices=('mixed', 'f64'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--native-python', type=Path,
                        default=ROOT / '.local-data/native-engine-venv/Scripts/python.exe')
    args = parser.parse_args()

    bars_path = ROOT / '.local-data' / 'factor-verify' / f'{args.symbol}-{args.tf}.bars.json'
    encoded = bars_path.read_bytes()
    bars = json.loads(encoded)
    config = {
        'symbol': args.symbol, 'timeframe': args.tf, 'crypto_profile': True,
        'population': args.population, 'generations': args.generations, 'max_depth': 6,
        'train_ratio': 0.7, 'walk_forward_folds': 3, 'top_n': 10, 'seed': 42, 'cost': None,
        'selection_v2': True, 'evolve_v2': True, 'research_profile': 'crypto_local_v2',
        'execution_model': 'signal_research',
        **({} if args.no_seeds else {'seed_tokens': champion_seed_tokens(args.symbol, args.tf)}),
    }
    controller = Controller(args.native_python, args.out)
    started = time.monotonic()
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='chrome', headless=True,
                                         args=['--enable-unsafe-webgpu', '--use-angle=d3d11'])
            try:
                page = browser.new_page()
                page.expose_function('nativeTestInvoke', controller.invoke)
                page.expose_function('nativeTestFault', lambda request: None)
                page.expose_function('nativeTestStats', lambda: {'starts': controller.starts, 'kills': 0})
                page.add_init_script(
                    "window.isTauri = true; window.__TAURI_INTERNALS__ = {invoke: (command, args) => window.nativeTestInvoke(command, args)}")
                page.on('console', lambda msg: print('[page]', msg.type, msg.text[:200], flush=True))
                page.goto(args.url.rstrip('/') + '/scripts/native-gpu-m3.html', wait_until='networkidle')
                page.wait_for_function("typeof window.nativeQualificationRun === 'function'", timeout=120000)
                result = page.evaluate(
                    'async input => await window.nativeQualificationRun(input)',
                    {'bars': bars, 'config': config})
            finally:
                browser.close()
        summary = {'symbol': args.symbol, 'tf': args.tf, 'seeds': not args.no_seeds,
                   'precision': args.precision, 'bars': len(bars),
                   'bars_sha256': hashlib.sha256(encoded).hexdigest(),
                   'process_starts': controller.starts,
                   'elapsed_seconds': round(time.monotonic() - started, 1),
                   'passed': result.get('task', {}).get('status') == 'completed'}
        for row in [result]:
            task = row.get('task') or {}
            champions = row.get('champions') or []
            # task.champions 是带 qualification 的最终冠军;start() 返回值可能缺该字段
            task_champions = task.get('champions') or []
            champions = champions or task_champions
            summary[f"{row['entrance']}_status"] = task.get('status')
            summary[f"{row['entrance']}_engine"] = task.get('engine') or task.get('actualEngine')
            summary[f"{row['entrance']}_champions"] = len(champions)
            summary[f"{row['entrance']}_qualified"] = sum(
                1 for c in champions if (c.get('qualification') or {}).get('status') == 'qualified')
            detail_key = f"{row['entrance']}_qualified_detail"
            summary[detail_key] = [
                {'text': c.get('text'), 'tokens': c.get('tokens'),
                 'sortino': (c.get('metrics') or {}).get('sortino'),
                 'holdout': (c.get('metrics') or {}).get('holdout_metrics')}
                for c in champions if (c.get('qualification') or {}).get('status') == 'qualified']
        args.out.write_text(json.dumps({'summary': summary, 'raw': result}, ensure_ascii=False,
                                       indent=1, default=str), encoding='utf-8')
        print(json.dumps(summary, ensure_ascii=False, default=str), flush=True)
        return 0 if summary['passed'] and summary.get('lab_qualified', 0) + summary.get('super_qualified', 0) > 0 else 1
    finally:
        controller.close()


if __name__ == '__main__':
    raise SystemExit(main())
