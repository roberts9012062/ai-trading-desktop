"""Independent, predeclared 2026 candidate admission. Never tune using holdout."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'public/pykernel'))
from factor_lab.features import active_feature_ids, feature_matrix
from factor_lab.feature_policy import search_feature_pool
from factor_lab.market import prepare_bars
from factor_lab.ops import OP_INDEX
from factor_lab.seed_templates import templates_for
from factor_lab.economic_templates import economic_templates
from factor_lab.vm import execute_for_bars, is_constant
from factor_lab.scoring.execution import ExecutionConfig, executable_cashflows
from factor_lab.scoring.evaluate import _sortino

OP = {k: 64 + v for k, v in OP_INDEX.items()}


def stats(flows, lo, hi):
    pnl = flows['pnl'][lo:hi]
    equity = np.r_[0., np.cumsum(pnl)]
    held = flows['held'][lo:hi]
    mid = len(pnl) // 2
    return {'net_return': float(pnl.sum()), 'sortino': float(_sortino(pnl, 365 * 24)),
            'max_drawdown': float(np.max(np.maximum.accumulate(equity) - equity)),
            'position_changes': int(np.count_nonzero(np.abs(np.diff(held)) > 1e-10)),
            'half_returns': [float(pnl[:mid].sum()), float(pnl[mid:].sum())],
            'fees': float(flows['fee'][lo:hi].sum()), 'funding': float(flows['funding_cf'][lo:hi].sum())}


def candidates(active):
    baseline = templates_for(active, '60m', economic=False)
    for fid in [0, 1, 2, 3, 4, 8, 9, 11, 12, 13, 24, 26, 31, 32, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 50, 51]:
        if fid not in active:
            continue
        for op in ('TS_MA_10', 'TS_MA_20', 'TS_MA_60'):
            for sign in ([], [OP['NEG']]):
                baseline.append([fid, OP[op], *sign])
    baseline = list(dict.fromkeys(tuple(t) for t in baseline))
    added = [tuple(t['tokens']) for t in economic_templates()
             if all(tok >= 64 or tok in active for tok in t['tokens'])]
    return baseline, list(dict.fromkeys([*baseline, *added]))


def audit(symbol):
    path = ROOT / '.local-data/factor-independent' / f'{symbol}-1h-2026.json'
    raw = path.read_bytes()
    manifest = json.loads(path.with_suffix('.manifest.json').read_text())
    if hashlib.sha256(raw).hexdigest() != manifest['sha256']:
        raise ValueError('Input checksum disagrees with official-archive manifest')
    bars = prepare_bars({'research_profile': 'crypto_local_v2', 'symbol': symbol}, json.loads(raw))
    n = len(bars)
    train, valid = int(n * .6), int(n * .8)
    matrix = feature_matrix(bars)
    active = search_feature_pool(active_feature_ids(matrix[:, :train], True, max_head_gap=250))
    cfg = ExecutionConfig(fee_rate=.0005, slippage_bps=2, execution_model='perp_next_open')
    stress_cfg = ExecutionConfig(**{**cfg.__dict__, 'stress_multiplier': 2})
    pools = dict(zip(('baseline', 'economic_hypotheses'), candidates(active)))
    cache, frozen = {}, {}
    for arm, pool in pools.items():
        scores = []
        for tokens in pool:
            if tokens not in cache:
                signal = execute_for_bars(list(tokens), matrix, bars)
                if signal is None or not np.isfinite(signal[500:train - 1]).all() or is_constant(signal[500:train - 1]):
                    cache[tokens] = None
                    continue
                cache[tokens] = (executable_cashflows(signal, bars, cfg), executable_cashflows(signal, bars, stress_cfg))
            if cache[tokens] is not None:
                train_stats = stats(cache[tokens][1], 500, train - 1)
                scores.append((train_stats['sortino'], tokens, train_stats))
        top = sorted(scores, key=lambda row: (-row[0], row[1]))[:5]
        if not top:
            raise ValueError(f'{symbol}/{arm}: no executable candidates')
        selected = max(top, key=lambda row: (stats(cache[row[1]][1], train + 1, valid - 1)['sortino'], -len(row[1])))
        tokens = selected[1]
        validation = stats(cache[tokens][1], train + 1, valid - 1)
        frozen[arm] = {'tokens': list(tokens), 'candidate_count': len(pool), 'executable_nonconstant': len(scores),
                       'training_2x': selected[2], 'validation_2x': validation,
                       'eligible_before_holdout': selected[2]['net_return'] > 0 and validation['net_return'] > 0
                                                  and validation['position_changes'] >= 10}
    # Write the frozen selection BEFORE inspecting sealed values. Both arms
    # share the same old candidates, splits and cost model.
    selection_path = ROOT / '.local-data/factor-independent' / f'{symbol}-selection.json'
    selection_path.write_text(json.dumps(frozen, indent=2), encoding='utf8')
    for arm, selected in frozen.items():
        normal, stress = cache[tuple(selected['tokens'])]
        selected['holdout'] = stats(normal, valid + 1, n - 1)
        selected['holdout_2x'] = stats(stress, valid + 1, n - 1)
        h = selected['holdout_2x']
        selected['qualified'] = (selected['eligible_before_holdout'] and selected['holdout']['net_return'] > 0
                                 and h['net_return'] > 0 and h['max_drawdown'] <= .25
                                 and min(h['half_returns']) > 0)
    new_tokens = {tuple(t['tokens']) for t in economic_templates()}
    economic_diagnostics = []
    for tokens, flows in cache.items():
        if tokens in new_tokens and flows is not None:
            # New hypotheses' train/validation explain rejection. Do not expose
            # additional holdouts and then pick a different hypothesis.
            economic_diagnostics.append({'tokens': list(tokens), 'training_2x': stats(flows[1], 500, train - 1),
                                         'validation_2x': stats(flows[1], train + 1, valid - 1)})
    result = {'symbol': symbol, 'bars': n, 'sha256': manifest['sha256'], 'start': manifest['start'], 'end': manifest['end'],
              'sources': manifest['sources'], 'active_features_training_only': active,
              'funding_settlement_events': manifest['funding_settlement_events'],
              'splits': {'train_end': train, 'validation_end': valid, 'holdout_end': n},
              'arms': frozen, 'economic_training_diagnostics': economic_diagnostics}
    print(json.dumps({'symbol': symbol, 'arms': frozen}), flush=True)
    return result


if __name__ == '__main__':
    output = ROOT / 'docs/experiments/factor-independent-2026-10-12.json'
    if output.exists():
        raise SystemExit('Sealed results already exist. Obtain new independent data; do not rerun selection on this holdout.')
    rows = [audit(symbol) for symbol in ('XRPUSDT', 'ADAUSDT', 'DOGEUSDT')]
    output.write_text(json.dumps({'protocol': 'docs/plans/2026-10-12-factor-quality-rounds-2-4.md',
                                 'method': '60/20/20; next-open linear perp; 5bp fee+2bp slippage single-side; 2x fee/slip stress; real event funding; additive unit-notional returns',
                                 'results': rows}, indent=2), encoding='utf8')
