"""Export full G2 using the unchanged desktop build on a fresh preview port."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_identity():
    files = [ROOT/'public/pykernel/factor_local.py', *sorted((ROOT/'public/pykernel/factor_lab').rglob('*.py')),
             ROOT/'src/workers/pyodide-backtest.worker.ts', ROOT/'src/lib/mining/gpu/shard-pool.ts', ROOT/'src/lib/py-worker.ts']
    return {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--suite', type=Path, required=True)
    parser.add_argument('--case', help='Optional symbol/timeframe for a diagnostic export')
    parser.add_argument('--skip-existing', action='store_true', help='Reuse only references with matching inputs and source hashes')
    args = parser.parse_args()
    manifest = json.loads(args.suite.read_text(encoding='utf-8'))
    from playwright.sync_api import sync_playwright
    lock = json.loads((ROOT/'public/pyodide/pyodide-lock.json').read_text())
    identity = source_identity()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True)
        try:
            page = browser.new_page()
            page.on('console', lambda msg: print(msg.text, flush=True) if msg.text.startswith('native-reference-stage') else None)
            page.on('pageerror', lambda exc: print(f'browser error: {exc}', flush=True))
            page.goto(args.url.rstrip('/')+'/scripts/native-gpu-reference.html', wait_until='networkidle')
            page.wait_for_function("typeof window.nativeGPUReference === 'function'")
            # Verify that the fresh browser build serves the original numerical
            # sources from this checkout, not a cached or edited CPU oracle.
            public = {name[len('public/'):]: digest for name, digest in identity.items() if name.startswith('public/')}
            observed = page.evaluate("""async (files) => Object.fromEntries(await Promise.all(Object.keys(files).map(async name => {
              const response = await fetch('/'+name, {cache: 'no-store'});
              if (!response.ok) throw new Error('Missing CPU source '+name);
              const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
              return [name, [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('')];
            })))""", public)
            if observed != public:
                raise ValueError('Browser CPU source hashes differ from frozen checkout')
            for case in manifest['cases']:
                key = case['symbol']+'/'+case['timeframe']
                if args.case and args.case != key:
                    continue
                print(f'exporting {key}', flush=True)
                bars_bytes = (args.suite.parent/case['bars']).read_bytes()
                config = json.loads((args.suite.parent/case['config']).read_text())
                candidate_path = args.suite.parent/case['candidates']
                candidates = json.loads(candidate_path.read_text()) if candidate_path.exists() else None
                reference_path = args.suite.parent/case['cpu_reference']
                if args.skip_existing and reference_path.exists():
                    saved = json.loads(reference_path.read_text(encoding='utf-8'))
                    if (saved.get('bars_sha256') == sha(bars_bytes) and saved.get('config') == config
                            and saved.get('candidates') == candidates
                            and saved.get('reference', {}).get('source_sha256') == identity
                            and saved['reference'].get('pyodide_lock_sha256') == sha((ROOT/'public/pyodide/pyodide-lock.json').read_bytes())
                            and saved['reference'].get('wasm_sha256') == sha((ROOT/'public/pyodide/pyodide.asm.wasm').read_bytes())):
                        print(f'reusing frozen CPU reference {key}', flush=True)
                        continue
                result = page.evaluate('async input => await window.nativeGPUReference(input)',
                                       {'bars': json.loads(bars_bytes), 'config': config, 'candidates': candidates})
                reference = {'engine': 'desktop-pyodide', 'pyodide': lock['info']['version'],
                             'python': lock['info']['python'], 'numpy': lock['packages']['numpy']['version'],
                             'source_sha256': identity, 'pyodide_lock_sha256': sha((ROOT/'public/pyodide/pyodide-lock.json').read_bytes()),
                             'wasm_sha256': sha((ROOT/'public/pyodide/pyodide.asm.wasm').read_bytes())}
                report = {**result, 'reference': reference, 'bars_sha256': sha(bars_bytes), 'config': config}
                candidate_path.write_text(json.dumps(result['candidates'], separators=(',', ':')), encoding='utf-8')
                reference_path.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False), encoding='utf-8')
                print(json.dumps({'case': key, 'evaluated': len(result['outputs']['evaluated']),
                                  'strict': len(result['outputs']['strict']), 'champions': len(result['outputs']['champions'])}), flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
