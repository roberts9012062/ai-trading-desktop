"""Read-only non-pivot quant audit. Uses actual server/desktop Python modules.

Run with the server venv Python; writes evidence only, never connects to trading APIs.
Synthetic PnL is execution-friction evidence, not a prediction of investment returns.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import json
import math
import random
import sys
import time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT.parent / "Decentralized transactions" / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(ROOT / "public" / "pykernel"))
import numpy as np
from app.services.ai_trading.strategies import compute_quant_signal, normalize_strategy_params, required_signal_bars
from app.services.ai_trading.strategies.strength_state import update_state
from app.services.factor_lab.features import clear_feature_matrix_cache, feature_matrix
from app.services.factor_lab.features.compute import FEATURE_NAMES, compute_features
from app.services.factor_lab import execute
from app.services.shortline.contract import Champion
from app.services.shortline.evaluator import FormulaEvaluator, EvaluatorError
from app.services.ai_trading.strategies.swing_pro import resample_bars
import strategies as desktop

REPAIRED = False

KINDS = ["n_breakout", "ma_cross", "macd_cross", "kdj_cross", "band_swing",
         "swing_pro", "strength_entry", "strength_entry_v2", "factor"]
DEFAULT = {k: {} for k in KINDS}
DEFAULT["factor"] = {"factor_tokens": [0, 135]}  # v3 NEG(RET)
DEFAULT["swing_pro"] = {"main_tf": "5m", "htf_tf": "15m"}
VARIANTS = {
    "n_breakout": [{"lookback": 10}, {}, {"lookback": 300}],
    "ma_cross": [{"fast_period": 3, "slow_period": 10}, {"ma_type": "ema"}, {"slow_period": 300}],
    "macd_cross": [{"fast_period": 6, "slow_period": 13, "signal_period": 5}, {}, {"slow_period": 200, "signal_period": 100}],
    "kdj_cross": [{"n_period": 5}, {}, {"use_zone": True}],
    "band_swing": [{"period": 10, "std_mult": 1.5}, {}, {"period": 60, "std_mult": 3}],
    "swing_pro": [{"main_tf": "5m", "htf_tf": "15m", "confirm_mode": "single"},
                  {"main_tf": "5m", "htf_tf": "15m", "confirm_mode": "resonance"},
                  {"main_tf": "5m", "htf_tf": "60m", "confirm_mode": "resonance"}],
    "strength_entry": [{"period": 7}, {}, {"exit_threshold": 60, "smooth2": 3}],
    "strength_entry_v2": [{"period": 7}, {}, {"period": 28, "cooldown": 5}],
    "factor": [{"factor_tokens": [0, 135]}, {"factor_tokens": [9, 135]},
               {"factor_tokens": [[0, 135], [9, 135]], "factor_weights": [0.7, 0.3]}],
}


def synthetic(regime, n=900, scale=1):
    rng = random.Random(90210)
    bars, prev = [], 100.0
    for i in range(n):
        if regime == "flat": close = 100.0
        elif regime == "up": close = 100 + i * .12 + math.sin(i * .19) * .5
        elif regime == "down": close = 160 - i * .1 + math.sin(i * .19) * .5
        elif regime == "range": close = 100 + math.sin(i * .13) * 7 + math.sin(i * .59)
        elif regime == "whipsaw": close = 100 + (1 if i % 2 else -1) * .5 + rng.uniform(-.2, .2)
        elif regime == "jump": close = 100 + (10 if (i // 30) % 2 else 0) + math.sin(i * .2)
        else: close = max(20, prev * (1 + rng.gauss(0, .012)))
        op = close if not bars or regime == "flat" else prev
        width = 0 if regime == "flat" else .15 + rng.random() * .3
        bars.append({"time": (datetime(2026, 1, 1) + timedelta(minutes=5*i)).strftime("%Y-%m-%d %H:%M:%S"),
                     "open": op*scale, "high": (max(op, close)+width)*scale,
                     "low": (min(op, close)-width)*scale, "close": close*scale,
                     "volume": 100 + rng.random()*200})
        prev = close
    return bars


def sig(kind, bars, params=None, mode="both", pos=None):
    return compute_quant_signal(kind, bars, DEFAULT[kind] if params is None else params, mode, pos)


def canonical(out):
    return {k: v for k, v in out.items() if k not in ("reason",)}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def matrix_audit():
    result = {}
    regimes = ["flat", "up", "down", "range", "whipsaw", "jump", "random"]
    for kind in KINDS:
        count, errors, forbidden, nan, actions = 0, [], [], [], Counter()
        for regime in regimes:
            data = synthetic(regime)
            for vi, params in enumerate(VARIANTS[kind]):
                for end in [0, 1, 5, 10, 20, 40, 80, 160, 240, 360, 600, 900]:
                    window = data[max(0, end-240):end]
                    for mode in ["both", "long_only", "short_only"]:
                        for direction in [None, "long", "short"]:
                            pos = None if direction is None else {"quantity": .005, "available_quantity": .005, "direction": direction}
                            count += 1
                            try:
                                out = sig(kind, window, params, mode, pos)
                                actions[out["action"]] += 1
                                if (mode == "long_only" and out["action"] == "open_short") or (mode == "short_only" and out["action"] == "open_long"):
                                    forbidden.append([regime, vi, end, mode, direction, out])
                                try: json.dumps(out, allow_nan=False)
                                except ValueError: nan.append([regime, vi, end, mode, direction])
                            except Exception as exc:
                                errors.append([regime, vi, end, mode, direction, type(exc).__name__, str(exc)])
        result[kind] = {"evaluations": count, "exceptions": errors[:10], "exception_count": len(errors),
                        "nonfinite_count": len(nan), "forbidden_count": len(forbidden), "actions": dict(actions)}
        print("matrix", kind, count, "errors", len(errors), flush=True)
    return result


def shortline_decision_audit():
    from app.services.shortline.contract import DecisionParams
    from app.services.shortline.decision import DecisionEngine, DecisionState
    results = {}
    for cadence in [3, 5, 10, 15, 30, 60]:
        traces = []
        for repeat in range(2):
            engine = DecisionEngine(DecisionParams(), cadence, "1m")
            state = DecisionState(); direction = None; trace = []; counts = Counter()
            blocked_bad = 0
            for second in range(0, 3*3600, cadence):
                ts = 1767225600000 + second*1000
                score = [.8, -.8, .0][(second//90)%3]
                age = cadence*4 if second % 113 == 0 else 0
                if second % 127 == 0: score = float("nan")
                out = engine.step(state, score=score, score_ts_ms=ts-age*1000, now_ms=ts, position_dir=direction)
                counts[out.action] += 1
                if (age or not math.isfinite(score)) and out.action != "hold": blocked_bad += 1
                if out.action == "open_long": direction = "long"
                elif out.action == "open_short": direction = "short"
                elif out.action == "close": direction = None
                trace.append([second, out.action, direction])
            traces.append(hashlib.sha256(json.dumps(trace).encode()).hexdigest())
        results[str(cadence)] = {"steps_per_run": len(trace), "deterministic": traces[0] == traces[1],
                                "trace_sha256": traces[0], "actions": dict(counts), "bad_score_actions": blocked_bad}
    return results


def probes():
    bars = synthetic("range")
    result = {}
    # Flat-market churn and scale sensitivity use the identical paths at different units.
    result["flat_band"] = sig("band_swing", synthetic("flat", 80))
    result["long_lookback"] = {k: {"240": sig(k, bars[-240:], p), "900": sig(k, bars, p)}
                               for k, p in {"ma_cross": {"slow_period": 300}, "n_breakout": {"lookback": 300},
                                            "macd_cross": {"slow_period": 200, "signal_period": 100}}.items()}
    result["backtest_120_parameter_cap"] = {k: {str(w): sig(k, bars[-w:], p) for w in [120, 240, 900]}
        for k,p in {"ma_cross": {"slow_period": 150}, "n_breakout": {"lookback": 150},
                    "macd_cross": {"slow_period": 150, "signal_period": 9}, "band_swing": {"period": 150}}.items()}
    result["scale"] = {}
    for kind in ["ma_cross", "macd_cross", "kdj_cross", "band_swing", "n_breakout"]:
        baseline = synthetic("range")
        tiny = synthetic("range", scale=1e-7)
        mismatches = []
        for end in range(241, 901):
            a = sig(kind, baseline[end-240:end])
            b = sig(kind, tiny[end-240:end])
            if a["action"] != b["action"]:
                mismatches.append({"end": end, "normal": a["action"], "tiny": b["action"]})
        result["scale"][kind] = {"evaluations": 660, "action_mismatches": len(mismatches), "examples": mismatches[:4]}
    result["history_live_window_parity"] = {}
    for kind in KINDS:
        examples = []
        for end in range(241, 901, 5):
            a = sig(kind, bars[end-120:end])
            b = sig(kind, bars[end-240:end])
            if a["action"] != b["action"]:
                examples.append({"end": end, "history_120": a["action"], "live_240": b["action"],
                                 "history_signal": a.get("signal"), "live_signal": b.get("signal")})
        result["history_live_window_parity"][kind] = {"evaluations": 132, "mismatches": len(examples), "examples": examples[:4]}
    result["invalid_data"] = {}
    for kind in KINDS:
        cases = {}
        for bad in ["zero", "missing", "string", "nan", "inverted"]:
            data = copy.deepcopy(bars[-240:])
            if bad == "zero": data[-1]["close"] = 0
            elif bad == "missing": data[-1].pop("close")
            elif bad == "string": data[-1]["close"] = "broken"
            elif bad == "nan": data[-1]["close"] = float("nan")
            else: data[-1]["high"], data[-1]["low"] = 1, 200
            clear_feature_matrix_cache()
            try:
                out = sig(kind, data)
                finite = True
                try: json.dumps(out, allow_nan=False)
                except ValueError: finite = False
                cases[bad] = {"action": out["action"], "signal": out.get("signal"), "finite": finite}
            except Exception as exc: cases[bad] = {"exception": type(exc).__name__, "message": str(exc)}
        result["invalid_data"][kind] = cases
    # Cache must react to revised OHLCV even when close and timestamps remain unchanged.
    a = copy.deepcopy(bars[-240:]); b = copy.deepcopy(a)
    b[-1]["volume"] *= 100
    clear_feature_matrix_cache()
    first = feature_matrix(a)
    cached = feature_matrix(b)
    fresh = np.vstack([compute_features(b)[name] for name in FEATURE_NAMES])
    row = FEATURE_NAMES.index("RVOL")
    result["factor_cache_volume_revision"] = {"same_object": first is cached, "cached": float(cached[row,-1]),
                                              "fresh": float(fresh[row,-1]), "max_diff": float(np.nanmax(np.abs(cached-fresh))),
                                              "nonfinite_features": [name for idx,name in enumerate(FEATURE_NAMES) if not np.isfinite(fresh[idx]).all()]}
    # Mutation-independent causality: fixed normalization window must preserve prefixes.
    feats = compute_features(bars, normalization_window=200)
    result["causality"] = {}
    for end in [240, 360, 600]:
        short = compute_features(bars[:end], normalization_window=200)
        diff = max(float(np.nanmax(np.abs(short[name]-feats[name][:end]))) for name in FEATURE_NAMES if np.isfinite(short[name]).any())
        result["causality"][str(end)] = diff
    result["variable_normalization"] = {}
    all_feats = compute_features(bars)
    for end in [240, 360, 600]:
        short = compute_features(bars[:end])
        result["variable_normalization"][str(end)] = max(float(np.nanmax(np.abs(short[name]-all_feats[name][:end]))) for name in FEATURE_NAMES if np.isfinite(short[name]).any())
    # Local dispatch coverage is separate from the current server-backed history page.
    result["desktop_dispatch"] = {}
    for k in KINDS:
        try:
            result["desktop_dispatch"][k] = desktop.compute_quant_signal(k,bars[-240:],DEFAULT[k],"both",None)
        except ValueError as exc:
            result["desktop_dispatch"][k] = {"explicit_unsupported": str(exc)}
    result["desktop_parity"] = {}
    for kind in ["ma_cross", "n_breakout", "macd_cross", "kdj_cross", "band_swing", "factor"]:
        mismatches, checked = [], 0
        for end in range(240, 901, 20):
            for side in [None, "long", "short"]:
                pos = None if side is None else {"quantity": .005, "available_quantity": .005, "direction": side}
                server_params = {"factor_tokens":[0,71]} if kind == "factor" and REPAIRED else DEFAULT[kind]
                a = sig(kind, bars[end-240:end], server_params, pos=pos)
                # The baseline formula has unchanged feature id 0 across token spaces.
                p = {"factor_tokens": [0, 71]} if kind == "factor" else DEFAULT[kind]
                b = desktop.compute_quant_signal(kind, bars[end-240:end], p, "both", pos)
                checked += 1
                if a["action"] != b["action"]:
                    mismatches.append({"end": end, "position": side, "server": a["action"], "desktop": b["action"]})
        result["desktop_parity"][kind] = {"evaluations": checked, "action_mismatches": len(mismatches), "examples": mismatches[:5]}
    # 5m bars at 00:00,00:05,00:10,...; last 15m bucket is incomplete at end=242.
    grouped = resample_bars(bars[:242], 3)
    result["swing_pro_incomplete_htf"] = {"source_last_open": bars[241]["time"], "source_last_close": "2026-01-01 20:10:00",
                                          "aggregated_last_open": grouped[-1]["time"], "aggregated_count": len(grouped),
                                          "expected_closed_count": 80, "actual_last_volume": grouped[-1]["volume"]}
    from app.services.ai_trading.strategies.swing_pro import _latest_fresh_pivot, normalize_swing_pro_params
    pp = normalize_swing_pro_params({"left": 1, "right": 2, "min_right_live": 2,
                                    "min_amplitude_pct": 0, "min_atr_mult": 0})
    partial = []
    for end in range(241, 901):
        if end % 3 == 0: continue
        htf = resample_bars(bars[:end], 3)
        a, _ = _latest_fresh_pivot(htf, pp, 3)
        b, _ = _latest_fresh_pivot(htf if REPAIRED else htf[:-1], pp, 3)
        if a is not None and a != b:
            partial.append({"end": end, "partial_htf_pivot": a, "closed_only_pivot": b})
    result["swing_pro_incomplete_htf"]["pivot_changes"] = len(partial)
    result["swing_pro_incomplete_htf"]["examples"] = partial[:3]
    result["shortline"] = {}
    for version in ["shortline-eval-v1", "shortline-eval-v2"]:
        evaluator = FormulaEvaluator((Champion(1, (6, 135), .6), Champion(2, (9, 135), .4)), eval_version=version)
        vals = []
        for factor in [1, 10, 100]:
            forming = dict(bars[-1]); forming["volume"] *= factor
            r = evaluator.evaluate(bars[-240:-1], forming)
            vals.append(r["combo"])
        rejected = []
        for closed, forming in [(bars[:5], bars[5]), (bars[:240], None)]:
            try: evaluator.evaluate(closed, forming); rejected.append(False)
            except EvaluatorError: rejected.append(True)
        result["shortline"][version] = {"forming_volume_scores": vals, "warmup_and_missing_rejected": rejected}
    result["strength_entry_exit_conflict"] = {}
    for kind in ["strength_entry", "strength_entry_v2"]:
        found = []
        for end in range(241, 901):
            window = bars[end-240:end]
            a = sig(kind, window)
            if a["action"] not in ("open_long", "open_short"): continue
            side = "long" if a["action"] == "open_long" else "short"
            pos = {"quantity":.005,"available_quantity":.005,"direction":side}
            b = sig(kind,window,pos=pos)
            if REPAIRED:
                pos["opened_at"] = bars[end-1]["time"]
                b = sig(kind, bars[end-240:end], pos=pos)
            if b["action"] == "close": found.append({"end": end, "entry": a, "exit": b})
        result["strength_entry_exit_conflict"][kind] = {"count": len(found), "examples": found[:3]}
    result["shortline_decision_replay"] = shortline_decision_audit()
    return result


def replay(kind, bars, params, cost_bps, signal_cache):
    """Fixed 1000 notional PnL, next-bar open fills, per-side cost; no leverage/compounding.

    Strategy stop (swing_pro only) uses adverse gap fills. No user stop/TP rules.
    Cost is intentionally an aggregate fee+slippage sensitivity, not venue fee advice.
    """
    cash = 10000.0; initial = cash; qty = 0.0; entry = 0.0; trade_net = 0.0; opened_at = None
    peak = initial; maxdd = 0.; trades = []; actions = Counter(); samples = []
    state_params = dict(params)
    timeframe = "60m" if len(bars)>1 and (datetime.fromisoformat(bars[1]["time"])-datetime.fromisoformat(bars[0]["time"])).total_seconds()==3600 else "5m"
    width = required_signal_bars(kind,timeframe,params) if REPAIRED else 240
    for end in range(241, len(bars)):
        window = bars[max(0,end-width):end]
        pos = None if qty == 0 else {"quantity": abs(qty), "available_quantity": abs(qty), "direction": "long" if qty > 0 else "short", "opened_at": opened_at}
        # Strategy decisions depend on direction / nonzero quantity, not its size.
        # Share the deterministic signal between cost scenarios (local audit cache).
        cache_key = (end, "flat" if pos is None else pos["direction"], opened_at if pos is not None else None)
        if REPAIRED:
            cache_key += (json.dumps(state_params,sort_keys=True),)
        if cache_key not in signal_cache: signal_cache[cache_key] = sig(kind,window,state_params if REPAIRED else params,pos=pos)
        out = signal_cache[cache_key]
        if REPAIRED and kind in ("strength_entry","strength_entry_v2"):
            state_params = update_state(state_params,out,pos)
        action = out["action"]; actions[action] += 1
        fill = float(bars[end]["open"])
        # Signals observed at preceding bar close; execute on next bar open.
        if action == "close" and qty:
            gross = qty*(fill-entry); friction = abs(qty)*fill*cost_bps/10000
            cash += gross-friction; trades.append(trade_net+gross-friction); qty = 0
        elif action in ("open_long", "open_short") and qty == 0:
            qty = (1.0 if action == "open_long" else -1.0)*1000/fill
            opened_at = bars[end]["time"]
            entry = fill; fee = abs(qty)*fill*cost_bps/10000; cash -= fee; trade_net = -fee
            stop = out.get("sl_price")
            if REPAIRED and kind in ("strength_entry","strength_entry_v2"):
                state_params = update_state(state_params,out,{"opened_at":opened_at},executed=True)
        if qty and kind == "swing_pro" and stop:
            if (qty > 0 and bars[end]["low"] <= stop) or (qty < 0 and bars[end]["high"] >= stop):
                sf = min(fill, stop) if qty > 0 else max(fill, stop)
                gross = qty*(sf-entry); fee = abs(qty)*sf*cost_bps/10000
                cash += gross-fee; trades.append(trade_net+gross-fee); qty = 0
        eq = cash + qty*(float(bars[end]["close"])-entry)
        peak = max(peak, eq); maxdd = max(maxdd, (peak-eq)/peak)
        if end % 100 == 0: samples.append([end, round(eq, 4)])
    if qty:
        fill = float(bars[-1]["close"]); gross=qty*(fill-entry); fee=abs(qty)*fill*cost_bps/10000
        cash += gross-fee; trades.append(trade_net+gross-fee)
    return {"net_pnl": round(cash-initial, 6), "return_pct": round((cash/initial-1)*100, 6),
            "trades": len(trades), "win_pct": round(100*sum(t>0 for t in trades)/len(trades), 2) if trades else None,
            "max_drawdown_pct": round(maxdd*100, 6), "actions": dict(actions), "equity_samples": samples}


def replay_audit():
    datasets = {"synthetic_"+r: synthetic(r, 620) for r in ["flat", "up", "down", "range", "whipsaw", "jump", "random"]}
    provenance = {}
    for symbol in ["BTCUSDT", "ETHUSDT", "SOLUSDT"]:
        path = ROOT/".local-data"/"bench-bars"/(symbol+"-60m-3600.json")
        if not path.exists(): path = ROOT/"docs"/"audits"/"2026-10-05-quant"/"fixtures"/(symbol+"-60m.json")
        if not path.exists():
            print("missing optional historical fixture", symbol, flush=True)
            continue
        raw = json.loads(path.read_text(encoding="utf-8")); bars = raw if isinstance(raw,list) else raw.get("bars", [])
        if not bars: continue
        datasets[symbol+"_60m"] = bars[-850:]
        provenance[symbol] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                              "original_count": len(bars), "used_count": min(850, len(bars)), "start": bars[-850]["time"], "end": bars[-1]["time"]}
    results = {}
    for name, bars in datasets.items():
        print("replay", name, len(bars), flush=True)
        results[name] = {}
        for kind in KINDS:
            params = dict(DEFAULT[kind])
            if name.endswith("60m") and kind == "swing_pro": params.update(main_tf="60m", htf_tf="1d")
            cache = {}
            results[name][kind] = {str(cost): replay(kind, bars, params, cost, cache) for cost in [0, 5, 10]}
    return {"datasets": provenance, "results": results,
            "limitations": "1000 fixed quote notional, 10000 cash, no leverage; next-open fills; fee+slippage 0/5/10bps each side; strategy-only exits and swing_pro stops. Synthetic and short cached samples are NOT investment validation."}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--section", choices=["probes", "matrix", "replay", "all"], default="all")
    parser.add_argument("--output", type=Path, default=ROOT/"docs"/"audits"/"2026-10-05-quant")
    parser.add_argument("--repaired", action="store_true", help="Use shared windows and executed strength-signal state")
    args = parser.parse_args(); start=time.perf_counter()
    global REPAIRED
    REPAIRED = args.repaired
    for section, fn in [("probes", probes), ("matrix", matrix_audit), ("replay", replay_audit)]:
        if args.section in (section, "all"):
            save(args.output/(section+".json"), fn()); print("saved", section, "elapsed", round(time.perf_counter()-start,2), flush=True)


if __name__ == "__main__": main()
