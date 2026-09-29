"""Real browser CPU pool baseline vs sidecar, with nvidia-smi sampling.

Run a fresh Vite port, then this script using a Python with Playwright installed.
Native dependencies are isolated in .local-data/native-engine-venv (CPython 3.11).
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STARTUP_TIMEOUT_SECONDS = 300


def ready_record(process):
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("Sidecar exited before successful G1/ready handshake")
        try:
            value = json.loads(line)
            if value.get("type") == "native_engine_ready":
                return value
        except ValueError:
            pass


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", required=True)
    p.add_argument("--bars", type=Path, required=True)
    p.add_argument("--precision", choices=("mixed", "f64"), default="mixed")
    p.add_argument("--rounds", type=int, default=5)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--native-python", type=Path, default=ROOT / ".local-data/native-engine-venv/Scripts/python.exe")
    args = p.parse_args()
    bars_bytes = args.bars.read_bytes()
    bars = json.loads(bars_bytes)
    config = {"symbol": "ETHUSDT", "timeframe": "15m", "crypto_profile": True,
              "population": 3000, "max_depth": 6, "seed": 42, "generations": 100,
              "train_ratio": .7, "test_recent_bars": 0, "walk_forward_folds": 3, "cost": .0003}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    stderr_path, samples_path = args.out.with_suffix(".stderr.log"), args.out.with_suffix(".gpu.csv")
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    sidecar = sampler = None
    reader = ThreadPoolExecutor(max_workers=1)
    with stderr_path.open("w", encoding="utf-8") as error_log, samples_path.open("w", encoding="utf-8") as samples:
        try:
            sidecar = subprocess.Popen([str(args.native_python), "-u", "-m", "engine", "--precision", args.precision],
                cwd=ROOT, env={**os.environ, "PYTHONPATH": str(ROOT / "native-engine")},
                stdout=subprocess.PIPE, stderr=error_log, text=True, encoding="utf-8", **kwargs)
            endpoint = reader.submit(ready_record, sidecar).result(timeout=STARTUP_TIMEOUT_SECONDS)
            endpoint["pid"] = sidecar.pid
            print("native G1 passed; starting browser benchmark", flush=True)
            sampler = subprocess.Popen(["nvidia-smi", "--query-gpu=timestamp,index,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits", "-lms", "200"], stdout=samples, stderr=error_log, **kwargs)
            from playwright.sync_api import sync_playwright
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    page = browser.new_page()
                    page.on("console", lambda msg: print(msg.text, flush=True) if msg.text.startswith("native-benchmark-stage") else None)
                    page.on("console", lambda msg: print(f"vite diagnostic: {msg.text}", flush=True) if msg.text.startswith("[vite]") else None)
                    page.on("framenavigated", lambda frame: print(f"navigation: {frame.url}", flush=True) if frame == page.main_frame else None)
                    page.on("pageerror", lambda exc: print(f"browser error: {exc}", file=sys.stderr, flush=True))
                    # The application root redirects unauthenticated users to /login,
                    # destroying an in-flight benchmark's execution context.
                    page.goto(args.url.rstrip('/') + '/scripts/native-gpu-benchmark.html', wait_until="networkidle")
                    page.wait_for_function("typeof window.benchmarkNativeGPU === 'function'")
                    result = page.evaluate("async (input) => await window.benchmarkNativeGPU(input)",
                                          {"endpoint": endpoint, "bars": bars, "config": config, "rounds": args.rounds})
                finally:
                    browser.close()
            result["bars_sha256"] = hashlib.sha256(bars_bytes).hexdigest()
            result["recorded_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({k: result[k] for k in ("gate", "passed", "coverageEqual", "rounds", "bars_sha256")}))
            return 0 if result["passed"] else 1
        finally:
            for process in (sampler, sidecar):
                if process and process.poll() is None:
                    process.kill()
                    process.wait(timeout=15)
            reader.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    raise SystemExit(main())
