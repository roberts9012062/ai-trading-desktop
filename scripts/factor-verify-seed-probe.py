"""种子权威精算探针:直接驱动原生引擎(in-process),对给定 bars+config
跑 eval_shards/seeds → strict_eval → precise(final),输出合格判定与拒因。
用于把浏览器轨迹差异与数值口径差异分开。
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]

CHAMPION_SEEDS = [
    [6, 75, 106, 111, 111, 79, 79],
    [43, 83, 97, 98, 84],
    [21, 20, 64, 80, 94, 84],
    [9, 81, 43, 89, 68, 98, 107, 113, 9, 80, 49, 35, 65, 100, 72, 111, 78, 69],
    [20, 92, 47, 64, 92, 77, 94, 114],
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bars", required=True)
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--tf", default="1d")
    parser.add_argument("--population", type=int, default=600)
    parser.add_argument("--generations", type=int, default=40)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    bars = json.loads(Path(args.bars).read_text(encoding="utf-8"))
    config = {"symbol": args.symbol, "timeframe": args.tf, "crypto_profile": True,
              "population": args.population, "generations": args.generations,
              "max_depth": 6, "train_ratio": 0.7, "walk_forward_folds": 3,
              "top_n": 10, "seed": 42, "cost": None,
              "selection_v2": True, "evolve_v2": True,
              "research_profile": "crypto_local_v2",
              "execution_model": "signal_research",
              "seed_tokens": CHAMPION_SEEDS}

    from engine.runtime import initialize_runtime
    from engine.session import NativeSession
    runtime = initialize_runtime("mixed")
    session = NativeSession("probe", runtime, precision="mixed")
    # 与桌面 packNativeBars 等价的列编码:走 msgpack 协议太重,直接 records
    session.load_records(bars, {"max_bars": 100_000})
    session.prepare_features(config)
    evaluated = session.eval_shards(CHAMPION_SEEDS)
    payload = {"evaluated": evaluated, "best_seen": [], "prefetched_strict": [],
               "trials": args.population * args.generations, "final_generation": True}
    result = session.precise(payload)
    out = {
        "engine": runtime["engine_version"], "bars": len(bars),
        "champions": [{"text": c.get("text"), "tokens": c["tokens"],
                       "qualification": c.get("qualification"),
                       "sortino": (c["metrics"] or {}).get("sortino"),
                       "holdout": (c["metrics"] or {}).get("holdout_metrics")}
                      for c in result["champions"]],
        "rejected": [{"text": c.get("text"),
                      "reasons": (c.get("qualification") or {}).get("reasons"),
                      "holdout": (c.get("metrics") or {}).get("holdout_metrics")}
                     for c in result["rejected_candidates"]],
        "requirements": result["qualification_requirements"],
    }
    text = json.dumps(out, ensure_ascii=False, indent=1, default=str)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    session.dispose()


if __name__ == "__main__":
    sys.exit(main())
