# -*- coding: utf-8 -*-
"""严格筛分片对拍:mine_precise 本地判定 vs mine_strict_eval 分片预取。

验证三件事:
1. 分片入口(run_mine_strict_eval,模拟 worker 的 _SHARD 缓存)构造的
   判定上下文与主实例 _dedup_top 内部上下文同构:同一批候选的
   pass/cross_scores 逐位一致;
2. mine_precise 带 prefetched_strict(分片结果)与不带(本地判定)的
   最终输出(champions/best_seen)逐字节一致;
3. 候选不在预取表时(扩展轮)回退本地判定,结果仍一致。

用法: python -X utf8 scripts/verify-strict-shard.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import factor_local  # noqa: E402

BARS_PATH = Path(__file__).resolve().parents[1] / "docs" / "experiments" / "crypto-local-v2" / "bench-bars-btcusdt-15m.json"


def load_bars() -> list:
    if BARS_PATH.exists():
        return json.loads(BARS_PATH.read_text())
    # 兜底:确定性合成行情(标注 synthetic,验证语义仍成立)
    import random

    rng = random.Random(11)
    bars = []
    price = 60000.0
    from datetime import datetime, timedelta, timezone

    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for i in range(6000):
        ret = rng.gauss(0.00005, 0.004)
        price = max(1.0, price * (1 + ret))
        o = price * (1 - rng.uniform(0, 0.002))
        bars.append({
            "time": (t0 + timedelta(minutes=15 * i)).isoformat(),
            "open": o, "high": max(o, price) * 1.001, "low": min(o, price) * 0.999,
            "close": price, "volume": rng.uniform(10, 1000),
            "quote_volume": rng.uniform(5e5, 5e7), "trades": int(rng.uniform(100, 5000)),
            "taker_buy_volume": rng.uniform(5, 500),
        })
    return bars


def tree(i: int, d: int = 4) -> list:
    t: list = []
    s = i * 2654435761 % 2147483647
    def rnd():
        nonlocal s
        s = (s * 16807) % 2147483647
        return s / 2147483647
    def gen(depth):
        if depth <= 0 or rnd() < 0.3:
            t.append(int(rnd() * 62)); return
        t.append(64 + int(rnd() * 45)); gen(depth - 1); gen(depth - 1)
    gen(d)
    return t


def main() -> int:
    bars = load_bars()
    cfg = {
        "symbol": "btcusdt", "crypto_profile": True, "timeframe": "15m",
        "population": 60, "generations": 3, "max_depth": 4, "train_ratio": 0.7,
        "walk_forward_folds": 3, "top_n": 5, "cost": None,
        "selection_v2": True, "evolve_v2": True,
        "research_profile": "crypto_local_v2",
    }
    evaluated = [
        {"composite": 0.01 * (40 - i), "tokens": tree(i),
         "metrics": {"sortino": 0.8, "ann_ret": 0.2, "ts_ic": 0.05,
                     "composite": 0.01 * (40 - i), "oos_sortino": 0.3}}
        for i in range(40)
    ]

    def precise(sid: str, final: bool, prefetched=None) -> dict:
        factor_local.run(json.dumps({
            "mode": "mine_features", "gpu_session_id": sid,
            "symbol": cfg["symbol"], "crypto_profile": True,
            "timeframe": cfg["timeframe"], "train_ratio": cfg["train_ratio"],
            "research_profile": cfg["research_profile"], "cost": None,
        }), json.dumps(bars))
        return json.loads(factor_local.run(json.dumps({
            "mode": "mine_precise", "final_generation": final,
            "gpu_session_id": sid, **{k: v for k, v in cfg.items()
                                       if k not in ("symbol",)},
            "symbol": cfg["symbol"], "cost": None,
            "candidates": [], "evaluated": evaluated, "best_seen": [],
            "trials": 180,
            **({"prefetched_strict": prefetched} if prefetched is not None else {}),
        }), json.dumps([])))

    # 1) 分片预取(先 init _SHARD 缓存,再带候选判一遍)
    factor_local.run_mine_strict_eval(
        {**cfg, "mode": "mine_strict_eval", "candidates": []},
        bars,
    )
    shard = json.loads(factor_local.run_mine_strict_eval(
        {"mode": "mine_strict_eval", "candidates": [e["tokens"] for e in evaluated]},
        [],
    ))
    assert "error" not in shard, shard.get("error")
    strict = shard["strict"]

    # 2) 主实例本地判定(prefetched 缺省) vs 带分片预取:输出必须逐字节一致
    for final in (False, True):
        local_out = precise(f"vss-l{int(final)}", final)
        pref_out = precise(f"vss-p{int(final)}", final, prefetched=strict)
        if local_out != pref_out:
            print(f"[FAIL] prefetched 输出不一致(final={final})")
            return 1
        print(f"[OK] prefetched 与本地判定输出一致(final={final}, "
              f"champs={len(local_out.get('champions', []))}, "
              f"prefetch pass={sum(1 for s in strict if s['pass'])}/{len(strict)})")

    # 3) 截断预取表(模拟扩展轮 miss):剩余候选回退本地,结果仍须一致
    partial = strict[: len(strict) // 2]
    for final in (False, True):
        local_out = precise(f"vss-h{int(final)}", final)
        part_out = precise(f"vss-q{int(final)}", final, prefetched=partial)
        if local_out != part_out:
            print(f"[FAIL] 部分预取回退不一致(final={final})")
            return 1
    print("[OK] 部分预取(扩展轮 miss)回退本地判定,输出一致")

    print("全部通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
