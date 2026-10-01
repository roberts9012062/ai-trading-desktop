"""单例验证驱动:内核 CPU 产品路径(search) + 引擎合格门(qualification.py)。

跑一个 (symbol, timeframe, 配置) 组合:
- factor_local.run(mode=search) —— 与桌面 CPU 引擎同一内核代码与数值;
- 用 native-engine/engine/qualification.py 的 qualify_candidates(公开合格门,
  元数据逻辑无 GPU 依赖)对冠军做与产品一致的合格判定;
- 输出 JSON:合格数/拒因分布/冠军明细。

用法:
  python scripts/factor-verify-run.py --symbol BTCUSDT --tf 30m \
      [--population 600] [--generations 40] [--seeds] [--out result.json]
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "public" / "pykernel"), str(ROOT / "native-engine")]

import factor_local  # noqa: E402
from factor_lab.scoring.split_plan import build_split_plan  # noqa: E402
from factor_lab.scoring.walk_forward import WARMUP_BARS  # noqa: E402
from factor_lab.search import SearchConfig  # noqa: E402

# G2 冻结合格冠军种子(与 src/lib/mining/champion-seeds.ts 同源)
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


def run_case(symbol: str, tf: str, population: int, generations: int,
             with_seeds: bool, folds: int = 3, label_span: int = 0) -> dict:
    bars_path = ROOT / ".local-data" / "factor-verify" / f"{symbol}-{tf}.bars.json"
    bars = json.loads(bars_path.read_text(encoding="utf-8"))
    payload = {
        "mode": "search",
        "symbol": symbol,
        "timeframe": tf,
        "crypto_profile": True,
        "population": population,
        "generations": generations,
        "max_depth": 6,
        "top_n": 10,
        "seed": 42,
        "cost": None,
        "train_ratio": 0.7,
        "walk_forward_folds": folds,
        "selection_v2": True,
        "evolve_v2": True,
        "research_profile": "crypto_local_v2",
        "execution_model": "signal_research",
        "final_generation": True,
        **({"label_span": label_span} if label_span > 1 else {}),
        **({"seed_tokens": champion_seed_tokens(symbol, tf)} if with_seeds else {}),
    }
    started = time.time()
    raw = factor_local.run(json.dumps(payload), json.dumps(bars))
    elapsed = time.time() - started
    champions = json.loads(raw)

    # 与引擎 requirements_for_context 同口径重建合格要求
    cfg = SearchConfig(**{k: payload[k] for k in (
        "population", "generations", "max_depth", "top_n", "seed", "cost",
        "train_ratio", "walk_forward_folds", "selection_v2", "evolve_v2",
        "research_profile", "execution_model", "crypto_profile",
        *(["label_span"] if label_span > 1 else []),
        
    ) if k in payload})
    plan = build_split_plan(len(bars), label_span=label_span or 1,
                            warmup=WARMUP_BARS, bars=bars)
    use_test = plan is not None and plan.sufficient
    train_len = plan.train_end if (plan is not None and plan.sufficient) else len(bars)
    requirements = {
        "test_required": use_test,
        "train_end": train_len,
        "wf_folds": folds,
        "sample_sufficient": plan is None or bool(plan.sufficient),
        "holdout_required": (bool(plan.sufficient and plan.holdout_end > plan.validation_end)
                             if plan is not None else False),
        "holdout_stress_required": plan is not None,
        "live_fill_gate": False,
        "live_entry_gate": 0.0,
        "execution_required": False,
    }
    candidates = []
    text_by_tokens = {tuple(c["tokens"]): c.get("text") for c in champions}
    for c in champions:
        metrics = dict(c.get("metrics") or {})
        # 内核 search() 的冠军凡带 validation_passed=True 即过了内核严格筛
        # (_strict_gate,与引擎 strict_eval 同一份判定,G2 对拍锁定);
        # fallback 行带 overfit_warning,不带 validation_passed——与引擎侧
        # 只给 strict_pool 标 native_strict_passed=True 的口径一致。
        if metrics.get("validation_passed") is True:
            metrics["native_strict_passed"] = True
        candidates.append({"tokens": c["tokens"], "composite": c.get("composite") or 0.0,
                           "metrics": metrics})
    from engine.qualification import qualify_candidates
    qualified = qualify_candidates(candidates, requirements, final_generation=True)

    reasons: dict[str, int] = {}
    for row in qualified["rejected"]:
        for r in row["qualification"]["reasons"]:
            reasons[r] = reasons.get(r, 0) + 1
    return {
        "symbol": symbol, "timeframe": tf, "seeds": with_seeds,
        "population": population, "generations": generations, "folds": folds,
        "bars": len(bars), "elapsed_s": round(elapsed, 1),
        "plan_sufficient": bool(plan.sufficient) if plan else None,
        "champions_total": len(champions),
        "qualified": len(qualified["champions"]),
        "rejected": len(qualified["rejected"]),
        "reasons": reasons,
        "qualified_detail": [
            {"text": text_by_tokens.get(tuple(c["tokens"])), "tokens": c["tokens"],
             "metrics": {k: c["metrics"].get(k) for k in (
                 "sortino", "ann_ret", "avg_turnover", "oos_conservative",
                 "dsr", "holdout_passed", "holdout_metrics", "walk_forward")}}
            for c in qualified["champions"]
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--tf", default="30m")
    parser.add_argument("--population", type=int, default=600)
    parser.add_argument("--generations", type=int, default=40)
    parser.add_argument("--folds", type=int, default=3)
    parser.add_argument("--label-span", type=int, default=0)
    parser.add_argument("--seeds", action="store_true")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    result = run_case(args.symbol, args.tf, args.population, args.generations,
                      args.seeds, args.folds, args.label_span)
    text = json.dumps(result, ensure_ascii=False, indent=1, default=str)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    sys.exit(main())
