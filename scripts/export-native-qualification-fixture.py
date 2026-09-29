"""Freeze both G2 reference layers for the requested-native fallback host gate."""
import argparse
import hashlib
import gzip
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native-engine'))
from engine.qualification import qualify_candidates
p = argparse.ArgumentParser()
p.add_argument('--report', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--suite', type=Path, default=ROOT/'.local-data/native-gpu-g2/suite.json')
args = p.parse_args()
report = json.loads(args.report.read_text(encoding='utf-8'))
if not report.get('passed') or not report.get('G2_complete') or len(report.get('records', [])) != 56:
    raise ValueError('Only a complete passing G2 can supply qualification fixtures')
cases = []
manifest = json.loads(args.suite.read_text(encoding='utf-8'))
configs = {(item['symbol'], item['timeframe']): json.loads((args.suite.parent/item['config']).read_text(encoding='utf-8')) for item in manifest['cases']}
for row in report['records']:
    for engine in ('cpu', 'native'):
        result = row[engine]
        requirements = row['native']['qualification_requirements']
        candidates = result['research_candidates']
        for final in (False, True):
            expected = qualify_candidates(candidates, requirements, final_generation=final)
            cases.append({'name': f"{row['symbol']}/{row['timeframe']}/{row['precision']}/{engine}/{final}",
                'candidates': candidates, 'required': requirements, 'final': final, 'expected': expected,
                'config': configs[(row['symbol'], row['timeframe'])]})
fixture = {'source': str(args.report.resolve().relative_to(ROOT)), 'report_sha256': hashlib.sha256(args.report.read_bytes()).hexdigest(),
           'qualification_sha256': hashlib.sha256((ROOT/'native-engine/engine/qualification.py').read_bytes()).hexdigest(), 'cases': cases}
args.out.parent.mkdir(parents=True, exist_ok=True)
encoded = json.dumps(fixture, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
args.out.write_bytes(gzip.compress(encoded, mtime=0) if args.out.suffix == '.gz' else encoded)
print(json.dumps({'cases': len(cases), 'bytes': args.out.stat().st_size}))
