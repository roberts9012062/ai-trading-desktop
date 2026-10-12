"""Reproducible bounded candidate audit; real data only, holdout used once.

Identical old candidates in both arms. Select top five on training, select one
on validation under 2x costs, then reveal that frozen choice on holdout. This
is a small admission pilot, not proof of live profitability or a GP benchmark.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public/pykernel"))
from factor_lab.features import feature_matrix
from factor_lab.market import prepare_bars
from factor_lab.ops import OP_INDEX
from factor_lab.seed_templates import templates_for
from factor_lab.scoring.execution import ExecutionConfig, executable_cashflows
from factor_lab.scoring.evaluate import _sortino
from factor_lab.vm import execute_for_bars, is_constant

OP = {k: 64 + v for k, v in OP_INDEX.items()}


def metrics(flows, lo, hi, periods):
    pnl = flows["pnl"][lo:hi]
    equity = np.r_[0.0, np.cumsum(pnl)]
    return {"net_return": float(pnl.sum()), "sortino": float(_sortino(pnl, periods)),
            "max_drawdown": float(np.max(np.maximum.accumulate(equity) - equity)),
            "fees": float(flows["fee"][lo:hi].sum()),
            "funding": float(flows["funding_cf"][lo:hi].sum())}


def candidates(active, extension):
    result = templates_for(active, "60m")
    for fid in [0, 1, 2, 3, 4, 8, 9, 11, 12, 13, 24, 26, 31, 32, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 50, 51]:
        for op in ("TS_MA_10", "TS_MA_20", "TS_MA_60"):
            for sign in ([], [OP["NEG"]]):
                result.append([fid, OP[op], *sign])
    if extension:
        for fid in (62, 63):
            for op in ("TS_MA_10", "TS_MA_20", "TS_MA_60"):
                for sign in ([], [OP["NEG"]]):
                    result.append([fid, OP[op], *sign])
            for state in (4, 26, 49):
                result.append([fid, state, OP["MUL"], OP["TS_MA_20"]])
                result.append([fid, state, OP["MUL"], OP["TS_MA_20"], OP["NEG"]])
    return [list(t) for t in dict.fromkeys(tuple(t) for t in result)]


def audit(path, symbol, timeframe, model):
    raw = path.read_bytes()
    data = json.loads(raw)
    if isinstance(data, dict):
        if data.get("synthetic") is not False:
            raise ValueError(f"Unverified or synthetic data: {path}")
        data = data["bars"]
    # The perpetual file has an independently recorded archive manifest.
    if model == "perp_next_open":
        manifest = json.loads(path.with_name(path.stem + ".manifest.json").read_text())
        if hashlib.sha256(raw).hexdigest() != manifest["sha256"]:
            raise ValueError("Archive hash disagrees with provenance manifest")
    bars = prepare_bars({"research_profile": "crypto_local_v2", "symbol": symbol}, data)
    n = len(bars)
    train, valid = int(n * .6), int(n * .8)
    matrix = feature_matrix(bars)
    # Admission uses only training availability; direct feeds absent here are excluded.
    from factor_lab.features import active_feature_ids
    active = [i for i in active_feature_ids(matrix[:, :train], True, max_head_gap=250) if i < 62]
    cfg = ExecutionConfig(fee_rate=.0005, slippage_bps=2, execution_model=model)
    periods = 365 * (96 if timeframe == "15m" else 24)
    arms = {}
    cache = {}
    for arm in ("repaired_baseline", "technical_candidates"):
        pool = candidates(active, arm == "technical_candidates")
        scores = []
        for tokens in pool:
            key = tuple(tokens)
            if key not in cache:
                factor = execute_for_bars(tokens, matrix, bars)
                if factor is None or is_constant(factor[500:train - 1]):
                    cache[key] = None
                    continue
                factor = np.where(np.isfinite(factor), factor, 0.0)
                normal = executable_cashflows(factor, bars, cfg)
                stress = executable_cashflows(factor, bars, ExecutionConfig(**{**cfg.__dict__, "stress_multiplier": 2}))
                cache[key] = (normal, stress)
            if cache[key] is None:
                continue
            normal, stress = cache[key]
            train_m = metrics(stress, 500, train - 1, periods)
            scores.append((train_m["sortino"], tokens, train_m))
        top = sorted(scores, key=lambda r: (-r[0], r[1]))[:5]
        # No holdout values enter this choice.
        selected = max(top, key=lambda r: (metrics(cache[tuple(r[1])][1], train + 1, valid - 1, periods)["sortino"], -len(r[1])))
        tokens = selected[1]
        normal, stress = cache[tuple(tokens)]
        arms[arm] = {"candidate_count": len(pool), "evaluated_nonconstant_count": len(scores), "tokens": tokens,
                     "training_2x": selected[2],
                     "validation_2x": metrics(stress, train + 1, valid - 1, periods),
                     "holdout": metrics(normal, valid + 1, n - 1, periods),
                     "holdout_2x": metrics(stress, valid + 1, n - 1, periods)}
    return {"symbol": symbol, "timeframe": timeframe, "model": model, "bars": n,
            "start": bars[0]["time"], "end": bars[-1]["time"], "sha256": hashlib.sha256(raw).hexdigest(),
            "splits": {"train_end": train, "validation_end": valid, "holdout_end": n}, "arms": arms}


if __name__ == "__main__":
    rows = []
    for filename, symbol, tf, model in [
        ("BTCUSDT-60m-3600.json", "BTCUSDT", "60m", "spot_long_flat"),
        ("ETHUSDT-60m-3600.json", "ETHUSDT", "60m", "spot_long_flat"),
        ("SOLUSDT-60m-3600.json", "SOLUSDT", "60m", "spot_long_flat"),
        ("ETHUSDT-15m-perp-70174.json", "ETHUSDT", "15m", "perp_next_open"),
    ]:
        result = audit(ROOT / ".local-data/bench-bars" / filename, symbol, tf, model)
        rows.append(result)
        print(json.dumps({"symbol": symbol, "tf": tf, "arms": result["arms"]}), flush=True)
    output = ROOT / "docs/experiments/factor-quality-2026-10-12.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"method": "fixed-candidate pilot; 60/20/20; next-open; fee 5bp + slip 2bp; 2x stress; long-flat spot; real event funding on perp; returns are additive at unit notional", "results": rows}, indent=2), encoding="utf8")
