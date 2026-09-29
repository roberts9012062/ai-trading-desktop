"""Positive GPU portfolio IPC verification with frozen G2 qualified champions.

Feeds the two ADAUSDT-30m f64 champions recorded by g2-full-m3.1-r1.json as the
complete seed population of a one-generation real native session through the
browser backend; asserts a non-null final portfolio and current-version f64
champion provenance. Python supervision adapter; Rust tested separately.
"""
import argparse
import importlib.util
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNERS = importlib.util.spec_from_file_location('native_m3_runners', ROOT/'scripts/verify-native-gpu-m3-runners.py')
RUNNERS_MODULE = importlib.util.module_from_spec(RUNNERS)
RUNNERS.loader.exec_module(RUNNERS_MODULE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, default=ROOT/'.local-data/native-gpu-reports/portfolio-positive-fixture.json')
    parser.add_argument('--native-python', type=Path, default=ROOT/'.local-data/native-engine-venv/Scripts/python.exe')
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text(encoding='utf-8'))
    bars = json.loads((ROOT/'.local-data/native-gpu-g2'/f"{fixture['symbol']}-{fixture['timeframe']}.bars.json").read_bytes())
    controller = RUNNERS_MODULE.Controller(args.native_python, 'none', args.out)
    started = time.monotonic()
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='chrome', headless=True)
            try:
                page = browser.new_page()
                page.set_default_timeout(1800000)
                page.expose_function('nativeTestInvoke', controller.invoke)
                page.expose_function('nativeTestFault', controller.inject)
                page.add_init_script("window.isTauri = true; window.__TAURI_INTERNALS__ = {invoke: (command, args) => window.nativeTestInvoke(command, args)}")
                page.goto(args.url.rstrip('/')+'/scripts/native-gpu-portfolio.html', wait_until='networkidle')
                page.wait_for_function("typeof window.nativePortfolioPositive === 'function'")
                result = page.evaluate('async input => await window.nativePortfolioPositive(input)',
                                       {'bars': bars, 'config': fixture['config'], 'precision': fixture['precision'],
                                        'seedTokens': fixture['seed_tokens']})
            finally:
                browser.close()
        result.update(elapsed_seconds=time.monotonic()-started, fixture=str(args.fixture),
                      bars=len(bars), precision=fixture['precision'], process_starts=controller.starts,
                      command_adapter='Python supervision of a real sidecar; not a packaged desktop test',
                      recorded_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        print(json.dumps({key: value for key, value in result.items() if key != 'portfolio'}, ensure_ascii=False), flush=True)
        return int(not result['passed'])
    finally:
        controller.close()


if __name__ == '__main__':
    raise SystemExit(main())
