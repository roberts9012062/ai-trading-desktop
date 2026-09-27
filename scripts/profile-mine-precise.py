# -*- coding: utf-8 -*-
"""剖析 mine_precise 在因子实验室深数据形态下的热点分布。

模拟:72k 根 15m 风格 bars(3600 根 fixture 平铺 ×20),selection_v2=True +
train_ratio=0.7 + walk_forward_folds=3(非 v2 profile),best_seen 跨代累积
(第 1 代空、第 5 代 ~40 条、第 10 代 ~60 条),每代送入 ~30 条 evaluated。
cProfile 输出 top 热点,确认分片切口(预期 _enrich 的 evaluate_on_slice/
walk_forward_eval 与 strict gate 占大头)。

用法: python -X utf8 scripts/profile-mine-precise.py
"""

import cProfile
import io
import json
import pstats
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import factor_local  # noqa: E402

SRC = ROOT / ".local-data" / "bench-bars" / "BTCUSDT-60m-3600.json"


def load_bars(repeat: int = 20) -> list:
    raw = json.loads(SRC.read_text())
    if isinstance(raw, dict):
        raw = raw.get("bars", raw)
    bars = []
    base_ts = 1_700_000_000_000
    for k in range(repeat):
        for b in raw:
            nb = dict(b)
            nb["time"] = base_ts + (k * len(raw) + raw.index(b)) * 3_600_000
            bars.append(nb)
    return bars


def rand_tokens(rng: random.Random) -> list:
    n = rng.randint(3, 8)
    toks = []
    for _ in range(n):
        r = rng.random()
        if r < 0.55:
            toks.append(rng.randrange(0, 36))
        else:
            toks.append(64 + rng.randrange(0, 40))
    return toks


def main() -> None:
    bars = load_bars(20)
    print(f"bars={len(bars)}")
    rng = random.Random(7)
    payload_base = {
        "symbol": "btcusdt",
        "timeframe": "60m",
        "crypto_profile": True,
        "population": 30,
        "generations": 15,
        "max_depth": 4,
        "train_ratio": 0.7,
        "walk_forward_folds": 3,
        "top_n": 10,
        "cost": None,
        "selection_v2": True,
        "evolve_v2": True,
    }

    best_seen: list = []
    # 预跑两代预热(特征矩阵/切片缓存),再剖析第 3 代
    for gen in range(3):
        cands = [rand_tokens(rng) for _ in range(30)]
        payload = {**payload_base, "mode": "mine_precise", "candidates": cands,
                   "best_seen": best_seen, "trials": 30 * 15, "final_generation": False}
        if gen == 2:
            prof = cProfile.Profile()
            t0 = time.perf_counter()
            prof.enable()
            out = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
            prof.disable()
            dt = time.perf_counter() - t0
        else:
            t0 = time.perf_counter()
            out = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
            dt = time.perf_counter() - t0
        best_seen = out.get("best_seen", [])
        print(f"gen{gen + 1}: {dt:.1f}s champs={len(out.get('champions', []))} best_seen={len(best_seen)}")

    s = io.StringIO()
    ps = pstats.Stats(prof, stream=s).sort_stats("cumulative")
    ps.print_stats(28)
    text = s.getvalue()
    # 只保留函数表,砍掉头部冗余
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if "ncalls" in l)
    print("\n".join(lines[start:start + 32]))


if __name__ == "__main__":
    main()
