"""短线冠军产出探针:验证 shortline_v1 修复后末代封存解封能产出合格冠军。

与 D2 证据脚本的区别:D2 用固定 6 个手挑候选(PRNG 噪声列,composite=0),
只验证链路结构;本脚本按真实搜索形态跑多轮"进化":慢算子加权随机树池
(镜像 TS 驱动的 slowBiasedOpSets 先验)→ rank_shards 粗排 → top 精评 →
精英+变异迭代 → strict → precise(final_generation=True)。候选列来自
真实 K 线派生(非 PRNG),断言的是"能出合格冠军"这一用户级目标。

用法:
  .local-data/native-engine-venv/Scripts/python.exe scripts/shortline-champion-probe.py \
      [--bars .local-data/bench-bars/ETHUSDT-15m-perp-70174.json] [--tail 30000]
"""
import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]

# 平滑/长窗算子(镜像 TS SMOOTH_KINDS + 60/120 窗族):采样池加权复制,
# 让初始种群与变异更密集落在低换手区(只改生成分布,不改数值口径)
SLOW_OPS = {64 + i for i in
            (13, 14, 15, 27, 28, 29, 30, 31, 32, 33, 38, 39, 41, 42, 43, 47, 48, 49)}


def attach_sl_columns(bars):
    """sl_of0=K线真实 taker 失衡;sl_of1..7=真实量价派生(非随机)。"""
    for b in bars:
        v = float(b.get("volume") or 0)
        buy = float(b.get("taker_buy_volume") or 0)
        o, h, l, c = (float(b.get(k) or 0) for k in ("open", "high", "low", "close"))
        rng_ = max(1e-9, h - l)
        qv = float(b.get("quote_volume") or 0)
        b["sl_of0"] = (2 * buy / v - 1) if v > 0 and 0 <= buy <= v else 0.0
        b["sl_of1"] = (c - o) / rng_
        b["sl_of2"] = (2 * (c - l) / rng_) - 1
        b["sl_of3"] = (v / qv) if qv > 0 else 0.0
        b["sl_of4"] = ((c / o) - 1) if o > 0 else 0.0
        b["sl_of5"] = ((h + l) / 2 - c) / rng_
        b["sl_of6"] = (2 * buy / v - 1) * ((c - o) / rng_) if v > 0 else 0.0
        b["sl_of7"] = ((v - buy) / v - 0.5) if v > 0 else 0.0
    return bars


class Sampler:
    def __init__(self, feats, ones, twos):
        self.feats = list(feats)
        # 慢算子在采样池 ×4 复制(等价 TS slowBiasedOpSets 的加权思路)
        self.ones = [t for t in ones for _ in range(4 if t in SLOW_OPS else 1)]
        self.twos = [t for t in twos for _ in range(4 if t in SLOW_OPS else 1)]
        self.arity = {t: 1 for t in ones}
        self.arity.update({t: 2 for t in twos})

    def tree(self, rng, depth):
        if depth <= 0 or (self.twos and rng.random() < 0.25):
            return [rng.choice(self.feats)]
        if self.twos and rng.random() < 0.3:
            return self.tree(rng, depth - 1) + self.tree(rng, depth - 1) + [rng.choice(self.twos)]
        return self.tree(rng, depth - 1) + [rng.choice(self.ones)]

    def mutate(self, rng, tokens):
        """同 arity 换算子 / 换特征,后缀合法性保持不变。"""
        out = list(tokens)
        for _ in range(1 + rng.randrange(2)):
            i = rng.randrange(len(out))
            t = out[i]
            if t in self.arity:
                same = [o for o in (self.ones if self.arity[t] == 1 else self.twos) if o != t]
                if same:
                    out[i] = rng.choice(same)
            else:
                out[i] = rng.choice(self.feats)
        return out


def valid(tokens):
    from engine.vm_ti import validate_tokens
    try:
        validate_tokens(tokens, 70)
        return True
    except ValueError:
        return False


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bars", type=Path, default=ROOT / ".local-data/bench-bars/ETHUSDT-15m-perp-70174.json")
    p.add_argument("--tail", type=int, default=30000)
    p.add_argument("--population", type=int, default=240)
    p.add_argument("--rounds", type=int, default=12)
    p.add_argument("--top", type=int, default=24)
    p.add_argument("--seed", type=int, default=20261001)
    p.add_argument("--profile", default="shortline_v1", choices=["shortline_v1", "crypto_local_v2"],
                   help="crypto_local_v2 作对照:同样的门与窗口,隔离短线口径的影响")
    p.add_argument("--out", type=Path, default=ROOT / ".local-data/native-gpu-reports/champion-probe.json")
    args = p.parse_args()

    shortline = args.profile == "shortline_v1"
    bars = [dict(b) for b in json.loads(args.bars.read_bytes())[-args.tail:]]
    bars = attach_sl_columns(bars) if shortline else bars
    print(f"bars={len(bars)} (real, tail {args.tail}) profile={args.profile}", flush=True)

    from engine.runtime import initialize_runtime
    from engine.session import NativeSession
    runtime = initialize_runtime("mixed", require_cuda=True)
    session = NativeSession("champion-probe", runtime, "mixed")
    try:
        config = {"symbol": "ETHUSDT", "timeframe": "15m", "crypto_profile": True,
                  "research_profile": args.profile, "population": args.population,
                  "generations": args.rounds, "max_depth": 5, "seed": args.seed,
                  "train_ratio": 0.7, "walk_forward_folds": 3,
                  "cost": 0.0003, "top_n": 6, "selection_v2": True, "evolve_v2": True}
        session.load_records(bars, {"max_bars": 100_000})
        info = session.prepare_features(config)
        active = list(info["active_feature_ids"])
        print(f"matrix_rows={len(info['feature_names'])} active={len(active)}", flush=True)

        import importlib
        ops = importlib.import_module("factor_lab.ops").OPS_CONFIG
        sampler = Sampler(active,
                          [64 + i for i, c in enumerate(ops) if c[2] == 1],
                          [64 + i for i, c in enumerate(ops) if c[2] == 2])
        rng = random.Random(args.seed)

        best = {}  # tokens-key -> (composite, tokens, metrics)
        last_evaluated = []
        for round_no in range(1, args.rounds + 1):
            pool, seen = [], set()
            elites = sorted(best.values(), key=lambda r: -r[0])[:8]
            for comp, tokens, _ in elites:  # 精英直接入池
                if tuple(tokens) not in seen:
                    seen.add(tuple(tokens)); pool.append(list(tokens))
            while len(pool) < args.population:  # 变异 + 新血
                if elites and rng.random() < 0.5:
                    cand = sampler.mutate(rng, rng.choice(elites)[1])
                else:
                    cand = sampler.tree(rng, 4)
                key = tuple(cand)
                if key in seen or not 1 <= len(cand) <= 32 or not valid(cand):
                    continue
                seen.add(key); pool.append(cand)
            ranked = session.rank_shards(pool)
            selected = [row["tokens"] for row in ranked[:args.top]]
            evaluated = session.eval_shards(selected)
            last_evaluated = evaluated
            for row in evaluated:
                key = tuple(row["tokens"])
                if key not in best or row["composite"] > best[key][0]:
                    best[key] = (row["composite"], row["tokens"], row["metrics"])
            top = max(r[0] for r in best.values())
            print(f"round {round_no}/{args.rounds} pool={len(pool)} top_composite={top:.4f} "
                  f"coarse={ranked[0]['score'] if ranked else None}", flush=True)

        final_tokens = [r[1] for r in sorted(best.values(), key=lambda r: -r[0])[:args.top]]
        strict = session.strict_eval(final_tokens)
        precise = session.precise({"candidates": final_tokens, "evaluated": last_evaluated,
                                   "best_seen": [{"composite": c, "tokens": t, "metrics": m}
                                                 for c, t, m in best.values()],
                                   "prefetched_strict": strict,
                                   "trials": args.population * args.rounds,
                                   "final_generation": True})

        champions = precise["champions"]
        counts = {"champions": len(champions),
                  "pending": len(precise["pending_candidates"]),
                  "rejected": len(precise["rejected_candidates"])}
        reasons = {}
        for c in precise["rejected_candidates"]:
            for r in (c.get("qualification") or {}).get("reasons", []):
                reasons[r] = reasons.get(r, 0) + 1
        rows = [{"tokens": c["tokens"], "text": c.get("text"), "composite": c.get("composite"),
                 "holdout": (c.get("metrics") or {}).get("holdout_metrics")}
                for c in champions]
        rejected_detail = []
        for c in precise["rejected_candidates"]:
            m = c.get("metrics") or {}
            rejected_detail.append({
                "tokens": c["tokens"], "text": c.get("text"), "composite": c.get("composite"),
                "reasons": (c.get("qualification") or {}).get("reasons"),
                "validation_passed": m.get("validation_passed"),
                "candidate_status": m.get("candidate_status"),
                "test_sortino": (m.get("test_metrics") or {}).get("sortino"),
                "holdout_metrics": m.get("holdout_metrics"),
                "holdout_passed": m.get("holdout_passed"),
                "flip_rate": m.get("flip_rate"), "half_life": m.get("half_life"),
                "avg_turnover": m.get("avg_turnover"),
            })
        report = {"gate": "champion-probe", "bars": len(bars), "rounds": args.rounds,
                  "counts": counts, "reject_reasons": reasons, "champions": rows,
                  "rejected_detail": rejected_detail}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"counts": counts, "reject_reasons": reasons}, ensure_ascii=False), flush=True)
        for r in rows:
            print(f"CHAMPION composite={r['composite']:.4f} {r['text']}", flush=True)
        for r in rejected_detail:
            print(f"REJECTED composite={r['composite']} reasons={r['reasons']} "
                  f"test_sortino={r['test_sortino']} holdout={r['holdout_metrics']}", flush=True)
        return 0 if champions else 1
    finally:
        session.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
