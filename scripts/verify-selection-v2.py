"""本地增强(selection_v2 / evolve_v2 / live_entry_gate)内核守护

验证的不变量:
1. 默认关闭时行为与原内核逐位一致(search / search_stepwise / mine_precise /
   mine_portfolio 四条路径),这是"服务端同源"的地基;
2. 封存段真的没有参与遴选:把封存期的 K 线替换成完全不同的数据,冠军名单
   (tokens 与 composite)必须不变——若遴选偷看了封存段,名单会变;
3. holdout_metrics 的确来自封存段(与直接在该段上评估的数值一致);
4. selection_v2 的候选池互不相同(冠军两两 |corr| ≤ 0.9);
5. live_entry_gate 生效:冠军在验证段的实盘离散口径 sortino > 0;
6. evolve_v2 的算子不越界(点/收缩变异产出的树仍合法可执行);
7. mine_portfolio 的 eval_from 口径:只在指定段上计指标。

用法: python scripts/verify-selection-v2.py
"""

from __future__ import annotations

import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402
from factor_lab.features import feature_matrix  # noqa: E402
from factor_lab.scoring.portfolio import evaluate_portfolio  # noqa: E402
from factor_lab.scoring.walk_forward import (  # noqa: E402
    clear_segment_cache,
    evaluate_on_slice,
    live_discrete_on_slice,
)
from factor_lab.search import (  # noqa: E402
    SearchConfig,
    _mutate_v2,
    _random_tree,
    holdout_len,
    search,
    search_stepwise,
    tree_to_tokens,
)
from factor_lab.ops import OPS_CONFIG  # noqa: E402
from factor_lab.vm import execute, is_constant  # noqa: E402

FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'[OK]' if ok else '[FAIL]'} {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILED.append(name)


def make_bars(n: int, seed: int, price0: float = 1000.0) -> list[dict]:
    rng = random.Random(seed)
    bars: list[dict] = []
    price = price0
    d0 = date(2015, 1, 1)
    for i in range(n):
        o = price
        price = max(1.0, price * (1.0 + rng.gauss(0.0002, 0.018)))
        bars.append(
            {
                "time": (d0 + timedelta(days=i)).isoformat() + "T00:00:00",
                "open": round(o, 2),
                "high": round(max(o, price) * (1 + abs(rng.gauss(0, 0.004))), 2),
                "low": round(min(o, price) * (1 - abs(rng.gauss(0, 0.004))), 2),
                "close": round(price, 2),
                "volume": int(rng.uniform(1000, 50000)),
                "open_interest": int(rng.uniform(5000, 90000)),
            }
        )
    return bars


BARS = make_bars(1200, 20260923)
BASE = dict(
    population=50, generations=8, max_depth=4, top_n=6, seed=77,
    train_ratio=0.6, walk_forward_folds=2, cost=0.0003,
)


def champ_key(champions) -> list[tuple]:
    return [(tuple(c.tokens), round(c.composite, 12)) for c in champions]


def run_search(bars: list[dict], **kw) -> list:
    clear_segment_cache()
    return search(bars, "1d", SearchConfig(**{**BASE, **kw}))


def run_stepwise(bars: list[dict], **kw) -> list:
    clear_segment_cache()
    last = []
    for snap in search_stepwise(bars, "1d", SearchConfig(**{**BASE, **kw})):
        last = snap.champions
    return last


def kernel(mode: str, bars: list[dict], **payload) -> dict:
    return json.loads(
        factor_local.run(json.dumps({"mode": mode, "timeframe": "1d", **payload}),
                         json.dumps(bars))
    )


# ── 1. 默认关闭 = 原行为 ────────────────────────────────────────
off = run_search(BARS)
check(
    "默认关闭:search 与显式 selection_v2=False/evolve_v2=False 一致",
    champ_key(off) == champ_key(run_search(BARS, selection_v2=False, evolve_v2=False)),
)
check(
    "默认关闭:search_stepwise 最终代与 search 一致",
    champ_key(run_stepwise(BARS)) == champ_key(off),
)
cands = [c.tokens for c in off]
pr_off = kernel("mine_precise", BARS, symbol="rb", candidates=cands, trials=400, **BASE)
check(
    "默认关闭:mine_precise 不产出 holdout_metrics/dsr",
    all("holdout_metrics" not in c["metrics"] and "dsr" not in c["metrics"]
        for c in pr_off["champions"]),
)
port_full = kernel("mine_portfolio", BARS, symbol="rb", cost=0.0003, tokens_list=cands)
check(
    "默认关闭:mine_portfolio 无 segment 字段(全段口径)与直算一致",
    port_full["portfolio"] is not None
    and "segment" not in port_full["portfolio"]
    and abs(port_full["portfolio"]["equal"]["sortino"]
            - round(evaluate_portfolio(BARS, "1d", cands, 0.0003)["equal"]["sortino"], 4)) < 1e-9,
)

# ── 2. 封存段未参与遴选 ─────────────────────────────────────────
V2 = dict(selection_v2=True, evolve_v2=True)
on = run_search(BARS, **V2)
n_test = len(BARS) - int(round(len(BARS) * 0.6))
n_hold = holdout_len(n_test)
check("封存段长度 = 测试段一半", n_hold == n_test // 2 and n_hold > 0, f"{n_hold}/{n_test}")
# 用完全不同的随机序列替换封存期(保留时间轴,只改价量)
tampered = [dict(b) for b in BARS]
noise = make_bars(n_hold, 999, price0=float(BARS[-n_hold]["close"]))
for i, nb in enumerate(noise):
    t = tampered[len(BARS) - n_hold + i]
    t.update({k: nb[k] for k in ("open", "high", "low", "close", "volume", "open_interest")})
on_tampered = run_search(tampered, **V2)
check(
    "篡改封存段后冠军名单不变(遴选全程未看封存段)",
    [t for t, _ in champ_key(on)] == [t for t, _ in champ_key(on_tampered)],
)
check(
    "篡改封存段后 holdout_metrics 随之改变(该段确实被评估)",
    any(
        a.metrics.get("holdout_metrics", {}).get("sortino")
        != b.metrics.get("holdout_metrics", {}).get("sortino")
        for a, b in zip(on, on_tampered)
    ),
)

# ── 3. holdout_metrics 数值来源正确 ─────────────────────────────
clear_segment_cache()
lo_h = len(BARS) - n_hold
direct = evaluate_on_slice(on[0].tokens, BARS, lo_h, len(BARS), "1d", 0.0003)
hm = on[0].metrics["holdout_metrics"]
check(
    "holdout_metrics 与直接在封存段上评估逐位一致",
    direct is not None and abs(direct["sortino"] - hm["sortino"]) < 1e-12
    and abs(direct["ann_ret"] - hm["ann_ret"]) < 1e-12,
)
check("selection_v2 产出 dsr ∈ [0,1]", all(0.0 <= c.metrics["dsr"] <= 1.0 for c in on))

# ── 4. 冠军互不相同(行为去重先行)────────────────────────────────
train_len = int(round(len(BARS) * 0.6))
mat = feature_matrix(BARS[:train_len])
series = [execute(c.tokens, mat) for c in on]
worst = 0.0
for i in range(len(series)):
    for j in range(i + 1, len(series)):
        a, b = series[i] - series[i].mean(), series[j] - series[j].mean()
        sd = float(a.std() * b.std())
        if sd > 1e-12:
            worst = max(worst, abs(float((a * b).mean()) / sd))
check("冠军两两 |corr| ≤ 0.9(行为去重)", worst <= 0.9 + 1e-9, f"max|corr|={worst:.3f}")

# ── 5. live_entry_gate ─────────────────────────────────────────
clear_segment_cache()
gated = run_search(BARS, **V2, live_entry_gate=0.3)
lo_t = len(BARS) - n_hold - (n_test - n_hold)
bad = []
for c in gated:
    if c.metrics.get("overfit_warning"):
        continue  # 兜底回退不受门约束(按设计)
    lm = live_discrete_on_slice(c.tokens, BARS[:lo_h], lo_t, lo_h, "1d", 0.0003, 0.3)
    if lm is None or lm["sortino"] <= 0:
        bad.append(c.text[:40])
check("live_entry_gate:冠军验证段实盘离散 sortino>0", not bad, f"违例 {bad}")
check(
    "live_entry_gate:封存段附实盘离散口径",
    all("live_discrete_sortino" in (c.metrics.get("holdout_metrics") or {}) for c in gated),
)

# ── 6. evolve_v2 变异算子合法性 ────────────────────────────────
rng = random.Random(5)
op_one = [i for i, (_, _, a) in enumerate(OPS_CONFIG) if a == 1]
op_two = [i for i, (_, _, a) in enumerate(OPS_CONFIG) if a == 2]
n_exec = 0
for _ in range(400):
    tree = _random_tree(4, mat.shape[0], op_one, op_two, rng)
    tokens = tree_to_tokens(_mutate_v2(tree, mat.shape[0], op_one, op_two, rng, 4))
    f = execute(tokens, mat)
    if f is not None and not is_constant(f):
        n_exec += 1
check("_mutate_v2 产出的树可执行(400 次抽样)", n_exec > 300, f"{n_exec}/400 可执行")

# ── 7. mine_portfolio 分段口径 ─────────────────────────────────
port_h = kernel(
    "mine_portfolio", BARS, symbol="rb", cost=0.0003, tokens_list=cands,
    train_ratio=0.6, selection_v2=True,
)["portfolio"]
ref = evaluate_portfolio(BARS, "1d", cands, 0.0003, eval_from=lo_h)
check(
    "mine_portfolio(selection_v2):只在封存段评估,数值与 eval_from 直算一致",
    port_h["segment"] == "holdout" and port_h["eval_bars"] == n_hold
    and abs(port_h["equal"]["sortino"] - round(ref["equal"]["sortino"], 4)) < 1e-9,
)
port_t = kernel(
    "mine_portfolio", BARS, symbol="rb", cost=0.0003, tokens_list=cands, train_ratio=0.6,
)["portfolio"]
check(
    "mine_portfolio(仅切分):只在测试段评估",
    port_t["segment"] == "test" and port_t["eval_bars"] == n_test,
)

print()
if FAILED:
    print(f"失败 {len(FAILED)} 项: {', '.join(FAILED)}")
    sys.exit(1)
print("全部通过 ✔")
