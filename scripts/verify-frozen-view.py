# -*- coding: utf-8 -*-
"""冻结视图/签名快键对拍:缓存启用 vs 每次清空的输出必须逐字节一致。

覆盖三条消费路径(与浏览器真实调用同构):
1. run_mine_precise(无会话,非 v2,selection_v2+WF3,深数据,多代 best_seen 累积);
2. run_mine_strict_eval(分片 worker 视角:_SHARD 缓存初始化 + 多次候选判定);
3. run_mine_shard(分片评估:_SHARD 初始化 + 多次候选分片)。

用法: python -X utf8 scripts/verify-frozen-view.py
"""

import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import factor_local  # noqa: E402
from factor_lab.scoring import walk_forward as wf  # noqa: E402
from factor_lab import features as feats  # noqa: E402


def clear_caches() -> None:
    wf._CTX_CACHE.clear()
    wf._VIEW_CACHE.clear()
    wf._SEG_CACHE.clear()
    feats._SIG_CACHE.clear()
    feats._MATRIX_CACHE.clear()
    feats._PREFIX_CACHE.clear()
    factor_local._SHARD.pop("bars", None)
    factor_local._SHARD.pop("payload", None)


def load_bars(repeat: int) -> list:
    raw = json.loads(
        (ROOT / ".local-data" / "bench-bars" / "BTCUSDT-60m-3600.json").read_text()
    )
    if isinstance(raw, dict):
        raw = raw.get("bars", raw)
    bars, base = [], 1_700_000_000_000
    for k in range(repeat):
        for i, b in enumerate(raw):
            nb = dict(b)
            nb["time"] = base + (k * len(raw) + i) * 3_600_000
            bars.append(nb)
    return bars


def rand_tokens(rng: random.Random) -> list:
    n = rng.randint(3, 8)
    out = []
    for _ in range(n):
        out.append(rng.randrange(0, 36) if rng.random() < 0.55 else 64 + rng.randrange(0, 40))
    return out


CFG = {
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

NUM_GEN = 4


def run_precise_series(bars: list, clear_each: bool) -> list:
    rng = random.Random(11)
    best_seen = []
    outs = []
    for _ in range(NUM_GEN):
        if clear_each:
            clear_caches()
        payload = {
            **CFG,
            "mode": "mine_precise",
            "candidates": [rand_tokens(rng) for _ in range(30)],
            "best_seen": best_seen,
            "trials": 450,
            "final_generation": False,
        }
        out = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
        best_seen = out.get("best_seen", [])
        outs.append(out)
    return outs


def run_shard_series(bars: list, clear_each: bool) -> list:
    rng = random.Random(23)
    outs = []
    init = json.loads(
        factor_local.run(json.dumps({**CFG, "mode": "mine_eval_shard"}), json.dumps(bars))
    )
    outs.append(init)
    for _ in range(3):
        if clear_each:
            # 分片视角只清结果类缓存,_SHARD 的 bars/payload 是任务冻结输入,
            # 真实 worker 生命周期内不清 —— 对拍两边保持一致即可
            wf._CTX_CACHE.clear()
            wf._VIEW_CACHE.clear()
            wf._SEG_CACHE.clear()
            feats._SIG_CACHE.clear()
            feats._MATRIX_CACHE.clear()
        cands = [rand_tokens(rng) for _ in range(12)]
        outs.append(
            json.loads(factor_local.run(json.dumps({**CFG, "mode": "mine_eval_shard", "candidates": cands}), "[]"))
        )
        outs.append(
            json.loads(factor_local.run(json.dumps({**CFG, "mode": "mine_strict_eval", "candidates": cands[:8]}), "[]"))
        )
    return outs


def main() -> None:
    bars = load_bars(6)  # 21600 根:足够触发多切片,控制原生耗时
    print(f"bars={len(bars)}")

    t0 = time.perf_counter()
    warm = run_precise_series(bars, clear_each=False)
    t_warm = time.perf_counter() - t0

    t0 = time.perf_counter()
    cold = run_precise_series(bars, clear_each=True)
    t_cold = time.perf_counter() - t0

    ok = all(json.dumps(a) == json.dumps(b) for a, b in zip(warm, cold))
    print(f"[{'OK' if ok else 'FAIL'}] mine_precise 冷/热缓存输出逐字节一致"
          f"(warm {t_warm:.1f}s / cold {t_cold:.1f}s, {NUM_GEN} 代)")

    warm_s = run_shard_series(bars, clear_each=False)
    cold_s = run_shard_series(bars, clear_each=True)
    ok_s = all(json.dumps(a) == json.dumps(b) for a, b in zip(warm_s, cold_s))
    print(f"[{'OK' if ok_s else 'FAIL'}] shard/strict 分片冷/热缓存输出一致")

    # 跨代性能:第 2 轮(全热)每代应显著快于冷跑
    t0 = time.perf_counter()
    run_precise_series(bars, clear_each=False)
    t_hot = time.perf_counter() - t0
    print(f"热缓存二轮 {t_hot:.1f}s vs 冷跑 {t_cold:.1f}s({NUM_GEN} 代)")

    if not (ok and ok_s):
        sys.exit(1)
    print("全部通过 ✔")


if __name__ == "__main__":
    main()
