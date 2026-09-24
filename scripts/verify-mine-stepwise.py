"""M3 内核验证脚本:mine_start/mine_step 分代会话与一次性 search() 逐位一致。

验证三件事(文档 2.10 M3 验收的本地侧;服务端用同一份内核,结论外推):
1. 同 seed 同 bars 下,分代步进的最终 champions 与 search() 完全一致
   (tokens 与 composite 逐位相等)——"本地与服务端同源"的地基;
2. 中途 dispose 后以 start_generation + seed_best 续训,最终 best_composite
   不低于中断时(决策记录 D-1:历史最优注入保证不倒退);
3. 会话边界:不存在的 session 返回 error/dispose 幂等。

用法: python scripts/verify-mine-stepwise.py
"""

import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import factor_local  # noqa: E402
from factor_lab.search import SearchConfig, search  # noqa: E402


def make_bars(n: int = 420, seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    bars = []
    price = 1000.0
    d0 = date(2023, 1, 1)
    for i in range(n):
        ret = rng.gauss(0.0002, 0.018)
        o = price
        price = max(1.0, price * (1.0 + ret))
        h = max(o, price) * (1.0 + abs(rng.gauss(0, 0.004)))
        l = min(o, price) * (1.0 - abs(rng.gauss(0, 0.004)))
        bars.append(
            {
                "time": (d0 + timedelta(days=i)).isoformat() + "T00:00:00",
                "open": round(o, 2),
                "high": round(h, 2),
                "low": round(l, 2),
                "close": round(price, 2),
                "volume": int(rng.uniform(1000, 50000)),
                "open_interest": int(rng.uniform(5000, 90000)),
            }
        )
    return bars


CFG = dict(
    population=20,
    generations=6,
    max_depth=3,
    top_n=5,
    seed=42,
    train_ratio=0.7,
    walk_forward_folds=3,
    # 两条路径用同一显式成本(避免 search() 默认 0.0003 与 mine_start 的
    # cost=None 按品种解析出不同值,造成假性分歧)
    cost=0.0003,
)

BARS = make_bars()


def run_stepwise(
    sid: str, start_generation: int = 0, seed_best: list | None = None
) -> tuple[list[dict], float]:
    """推进到结束,返回 (最终champions, 最终best_composite)"""
    factor_local.mine_start(
        json.dumps(
            {
                "session_id": sid,
                "symbol": "rb8888",
                "timeframe": "1d",
                "start_generation": start_generation,
                "seed_best": seed_best,
                **CFG,
            }
        ),
        json.dumps(BARS),
    )
    champions: list[dict] = []
    best = float("-inf")
    while True:
        resp = json.loads(factor_local.mine_step(sid))
        assert not resp.get("error"), f"mine_step 出错: {resp}"
        if resp.get("done"):
            return champions, best
        champions = resp["champions"]
        best = max(best, resp["best_composite"]) if resp["champions"] else best


def main() -> int:
    # ── 1. 与 search() 逐位一致 ──────────────────────────────
    one_shot = search(BARS, "1d", SearchConfig(**CFG))
    stepped, stepped_best = run_stepwise("verify-1")

    assert len(one_shot) > 0, "search() 未产出冠军,数据或配置有问题"
    assert len(one_shot) == len(stepped), (
        f"冠军数不一致: search={len(one_shot)} stepwise={len(stepped)}"
    )
    for a, b in zip(one_shot, stepped):
        assert a.tokens == b["tokens"], f"tokens 不一致: {a.tokens} vs {b['tokens']}"
        assert a.composite == b["composite"], (
            f"composite 不一致: {a.composite} vs {b['composite']}"
        )
    print(f"[1/3] 分代步进与 search() 逐位一致: {len(one_shot)} 个冠军, "
          f"best_composite={stepped_best:.4f}")

    # ── 2. 中断 + 续训不倒退(D-1 语义) ──────────────────────
    factor_local.mine_start(
        json.dumps({"session_id": "verify-2", "symbol": "rb8888",
                    "timeframe": "1d", **CFG}),
        json.dumps(BARS),
    )
    gen = 0
    best_at_interrupt = float("-inf")
    seed_best: list = []
    while gen < 2:
        resp = json.loads(factor_local.mine_step("verify-2"))
        assert not resp.get("done"), "代数未跑满就结束,配置有误"
        gen = resp["generation"]
        best_at_interrupt = resp["best_composite"]
        seed_best = [
            {"composite": c["composite"], "tokens": c["tokens"], "metrics": c["metrics"]}
            for c in resp["champions"]
        ]
    factor_local.mine_dispose("verify-2")  # 模拟暂停:丢弃会话

    resumed_champions, resumed_best = run_stepwise(
        "verify-2r", start_generation=gen, seed_best=seed_best
    )
    assert resumed_best >= best_at_interrupt - 1e-12, (
        f"续训后 best_composite 倒退: {best_at_interrupt:.4f} → {resumed_best:.4f}"
    )
    print(f"[2/3] 中断(第{gen}代)后续训不倒退: "
          f"{best_at_interrupt:.4f} → {resumed_best:.4f}")

    # ── 3. 会话边界 ─────────────────────────────────────────
    err = json.loads(factor_local.mine_step("no-such-session"))
    assert err.get("error"), "未知会话应返回 error"
    assert factor_local.mine_dispose("no-such-session") == "{}"
    assert factor_local.mine_dispose("verify-1") == "{}"  # 已结束的会话再 dispose 幂等
    print("[3/3] 会话边界:未知会话 error/dispose 幂等")

    print("全部通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
