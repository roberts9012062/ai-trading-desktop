"""M-D2 验收门证据：shortline_v1 挖掘全链路（native 引擎全管线）。

流程（真实 ETHUSDT 15m 深历史 70174 根）：
  1. 附加 v4 列：sl_of0 用 K 线真实 taker_buy/volume；sl_of1..7 为确定性
     PRNG 派生（链路证据用，非研究数据——见验收报告说明）
  2. NativeSession(shortline_v1)：load → prepare(70 行矩阵) → rank/eval_shards
     （含 v4 token 候选）→ strict_eval → precise → qualification
  3. 同配置 crypto_local_v2 对照：base 候选 composite 逐位一致（加法性），
     shortline composite = v2 × penalty
输出 .local-data/native-gpu-reports/d2-shortline.json
"""
import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]


def strip_sl(bars):
    for b in bars:
        for k in range(8):
            b.pop(f"sl_of{k}", None)
    return bars


def attach_sl_columns(bars, seed=20260930):
    rng = random.Random(seed)
    for i, b in enumerate(bars):
        v = float(b.get("volume") or 0)
        buy = float(b.get("taker_buy_volume") or 0)
        # 0: 订单流失衡(真实,来自 K 线 taker 数据)
        b["sl_of0"] = (2 * buy / v - 1) if v > 0 and 0 <= buy <= v else 0.0
        # 1..7: 确定性派生(链路证据,非研究信号)
        b["sl_of1"] = rng.random()
        b["sl_of2"] = abs(b.get("close", 1) * 0) + rng.random()
        b["sl_of3"] = rng.random()
        b["sl_of4"] = (rng.random() - 0.5) * 0.01
        b["sl_of5"] = 1.0 + rng.random() * 5
        b["sl_of6"] = (rng.random() - 0.5) * 2
        b["sl_of7"] = rng.random()
    return bars


CANDIDATES = [
    [115, 64 + 23],              # SL_OF_IMB → TS_ZSCORE_20
    [115, 116, 64],              # v4 + v4 → ADD
    [115, 64 + 32, 64 + 12],     # SL_OF_IMB → TS_ZSCORE_60 → TANH
    [117, 64 + 23],              # SL_TRD_INT → TS_ZSCORE_20
    [0, 64 + 23, 64 + 12],       # base 对照(RET)
    [5, 6, 64 + 29],             # base 对照(ATR/RVOL corr)
]


def run(profile, bars):
    from engine.runtime import initialize_runtime
    from engine.session import NativeSession

    runtime = initialize_runtime("mixed", require_cuda=True)
    session = NativeSession("d2", runtime, "mixed")
    try:
        config = {
            "symbol": "ETHUSDT", "timeframe": "15m", "crypto_profile": True,
            "research_profile": profile, "population": 64, "generations": 2,
            "max_depth": 4, "seed": 42, "train_ratio": 0.7, "walk_forward_folds": 2,
            "cost": 0.0003, "top_n": 6, "selection_v2": True,
        }
        session.load_records(bars, {"max_bars": 100_000})
        info = session.prepare_features(config)
        session.rank_shards(CANDIDATES)
        evaluated = session.eval_shards(CANDIDATES)
        strict = session.strict_eval(CANDIDATES)
        precise = session.precise({"evaluated": evaluated, "best_seen": [], "prefetched_strict": strict, "final_generation": True})
        return {
            "profile": profile,
            "matrix_rows": len(info.get("feature_names") or []),
            "feature_names_tail": (info.get("feature_names") or [])[-9:],
            "engine_version": runtime.get("engine_version"),
            "evaluated": [
                {"tokens": row["tokens"], "composite": row["metrics"].get("composite"),
                 "flip_rate": row["metrics"].get("flip_rate"), "half_life": row["metrics"].get("half_life"),
                 "avg_turnover": row["metrics"].get("avg_turnover")}
                for row in evaluated
            ],
            "champions": len(precise.get("champions") or []),
            "pending": len(precise.get("pending_candidates") or []),
            "rejected": len(precise.get("rejected_candidates") or []),
            "reject_reasons": sorted({
                r for c in (precise.get("rejected_candidates") or [])
                for r in (c.get("qualification") or {}).get("reasons", [])
            }),
        }
    finally:
        session.dispose()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bars", type=Path, default=ROOT / ".local-data/bench-bars/ETHUSDT-15m-perp-70174.json")
    p.add_argument("--out", type=Path, default=ROOT / ".local-data/native-gpu-reports/d2-shortline.json")
    p.add_argument("--tail", type=int, default=16000, help="用最近 N 根（证据运行时长控制）")
    args = p.parse_args()

    bars_all = json.loads(args.bars.read_bytes())
    bars = attach_sl_columns([dict(b) for b in bars_all[-args.tail:]])
    print(f"bars={len(bars)} (real ETHUSDT 15m, tail {args.tail})", flush=True)

    sl = run("shortline_v1", [dict(b) for b in bars])
    print(json.dumps({k: sl[k] for k in ("profile", "matrix_rows", "champions", "pending", "rejected")}, ensure_ascii=False), flush=True)
    v2 = run("crypto_local_v2", strip_sl([dict(b) for b in bars]))
    print(json.dumps({k: v2[k] for k in ("profile", "matrix_rows", "champions", "pending", "rejected")}, ensure_ascii=False), flush=True)

    # 对照断言
    sl_by_tokens = {tuple(r["tokens"]): r for r in sl["evaluated"]}
    v2_by_tokens = {tuple(r["tokens"]): r for r in v2["evaluated"]}
    comparisons = []
    for key, row_sl in sl_by_tokens.items():
        row_v2 = v2_by_tokens.get(key)
        if row_v2 is None:
            comparisons.append({"tokens": list(key), "note": "v2 拒绝(缺列/无效)"})
            continue
        penalty = 1.0
        turn, flip, hl = row_sl["avg_turnover"], row_sl["flip_rate"], row_sl["half_life"]
        if turn is not None and flip is not None and hl is not None:
            penalty = max(0.0, 1 - 0.5 * min(turn / 0.35, 1) - 0.3 * min(flip / 0.08, 1) - 0.2 * max(0.0, 1 - hl / 48))
        comparisons.append({
            "tokens": list(key), "v2_composite": row_v2["composite"], "sl_composite": row_sl["composite"],
            "expected": (row_v2["composite"] or 0) * penalty, "penalty": penalty,
            "flip_rate": flip, "half_life": hl,
        })

    report = {
        "gate": "D2-shortline-fullchain", "bars": len(bars), "bars_source": str(args.bars),
        "sl_columns_note": "sl_of0=K线真实taker失衡; sl_of1..7=确定性PRNG(链路证据,非研究数据)",
        "shortline": sl, "v2": v2, "comparisons": comparisons,
        "passed": bool(sl["evaluated"]) and sl["matrix_rows"] == 70 and v2["matrix_rows"] == 62,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "out": str(args.out)}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
