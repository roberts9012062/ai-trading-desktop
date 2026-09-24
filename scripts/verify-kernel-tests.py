"""批次二内核不变量测试(文档第一部分「建议补充的测试」)。

随批次推进逐项添加:
- test_ts_ic_alignment(P0-3 验收):factor = next_ret(close) 时 _ts_ic ≈ 1.0
用法: python scripts/verify-kernel-tests.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402
from factor_lab.vm import execute  # noqa: E402
from factor_lab.features import feature_matrix  # noqa: E402
from factor_lab.scoring.evaluate import (  # noqa: E402
    _calmar,
    _ts_ic,
    evaluate_factor,
    next_ret,
)


def _make_close(n: int = 300, seed: int = 11) -> np.ndarray:
    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 0.02, n)
    close = 1000.0 * np.cumprod(1.0 + steps)
    return close


def test_ts_ic_alignment() -> None:
    """因子恰为下根收益本身时,IC 应 ≈ 1(P0-3 修复前因错位一根 ≈ 0)"""
    close = _make_close()
    ret = next_ret(close)
    ic = _ts_ic(ret.copy(), ret)  # factor = ret(已是 t→t+1 前向收益)
    assert ic > 0.999, f"IC 应≈1.0,实际 {ic:.4f}"
    # 反向因子 → IC ≈ -1
    ic_neg = _ts_ic(-ret, ret)
    assert ic_neg < -0.999, f"反向因子 IC 应≈-1.0,实际 {ic_neg:.4f}"


def test_calmar_zero_baseline() -> None:
    """P2-19:开盘即跌的回撤从 0(期初)起算,不再低估"""
    periods = 243
    pnl = np.full(100, -0.001)
    cal = _calmar(pnl, periods)
    # 新口径 dd=0.1(0→-0.1),ann=-0.243 → calmar=-2.43;旧口径 dd=0.099 → -2.454…
    assert abs(cal - (-0.243 / 0.1)) < 1e-9, f"零基线回撤口径不符: {cal}"


def test_oos_zero_platform() -> None:
    """OOS 零平台裁定守护(P1-4 加性罚分经项目负责人拍板不采纳,两端一致):
    样本外为负 → composite 恒等于 0.0;样本外为正 → base×oos_mult。
    与服务端 test_oos_zero_platform 同义,防止任一侧无意改动该口径。"""
    n = 400
    # A:前 300 根涨、后 100 根跌;因子恒做多 → 训练好看、样本外(后 25%)亏损
    close_a = 1000.0 * np.cumprod(np.concatenate([np.full(300, 1.005), np.full(100, 0.995)]))
    m_a = evaluate_factor(np.full(n, 3.0), close_a, cost=0.0, periods=243)
    assert m_a["oos_negative"], "A 应为样本外为负"
    assert m_a["composite"] == 0.0, (
        f"零平台口径:负样本外 composite 应恒为 0.0,实际 {m_a['composite']}"
    )
    assert m_a["oos_mult"] == 0.0

    # B:样本外为正 → 乘性奖励(base×min(1.2, 1+oos_sor*0.1))
    close_b = 1000.0 * np.cumprod(np.concatenate([np.full(300, 1.005), np.full(100, 1.005)]))
    m_b = evaluate_factor(np.full(n, 3.0), close_b, cost=0.0, periods=243)
    assert not m_b["oos_negative"]
    assert 0.0 < m_b["oos_mult"] <= 1.2
    assert m_b["composite"] > 0


def test_equity_matches_metrics() -> None:
    """P1-6:回测资金曲线与指标可对账——曲线总收益 = 指标累计 pnl(差值
    恰为最后一根未实现的 pnl;末根构造为平盘+零成本时严格相等)"""
    rng = np.random.default_rng(5)
    rets = rng.normal(0, 0.015, 299).tolist() + [0.0]  # 末根平盘
    close = 1000.0 * np.cumprod(1.0 + np.array(rets))
    bars = [
        {
            "time": f"2024-{(i // 28) % 12 + 1:02d}-{i % 28 + 1:02d}T00:00:00",
            "open": float(close[i]),
            "high": float(close[i] * 1.001),
            "low": float(close[i] * 0.999),
            "close": float(close[i]),
            "volume": 1000,
            "open_interest": 5000,
        }
        for i in range(len(close))
    ]
    out = json.loads(
        factor_local.run(
            json.dumps(
                {
                    "mode": "backtest_factor",
                    "symbol": "rb8888",
                    "timeframe": "1d",
                    "factor_tokens": [0],  # RET 特征
                    "initial_cash": 100000.0,
                    "cost": 0.0,
                }
            ),
            json.dumps(bars),
        )
    )
    n = out["bars"]
    assert out["equity_curve"][0]["equity"] == 100000.0, "首根不应有已实现盈亏(P1-6 右移)"
    total_realized = out["equity_curve"][-1]["equity"] / 100000.0 - 1.0
    total_from_metrics = out["metrics"]["ann_ret"] * n / out["metrics"]["periods"]
    # 末根平盘 + 零成本 → 末根 pnl=0,两侧应相等;metrics.ann_ret 经 4 位
    # 小数舍入,容差取舍入传播界(0.5e-4 × n/periods)
    tol = 0.5e-4 * n / out["metrics"]["periods"] + 1e-9
    assert abs(total_realized - total_from_metrics) < tol, (
        f"曲线与指标对账不符: {total_realized} vs {total_from_metrics} (tol={tol})"
    )


def test_no_lookahead() -> None:
    """P0-2 验收:尾部截断 20% 后重算,前 80% 的因子序列逐位不变。

    修复前(全样本 mean/std 归一化)必然失败——bar t 的因子值依赖整段
    (含未来)的分布;因果滚动归一化后前缀严格不变。仓位同理(position
    是因子的逐点函数)。"""
    rng = np.random.default_rng(23)
    rets = rng.normal(0, 0.015, 500)
    close = 1000.0 * np.cumprod(1.0 + rets)

    def mk_bars(c: np.ndarray) -> list[dict]:
        return [
            {
                "time": f"2024-{(i // 28) % 12 + 1:02d}-{i % 28 + 1:02d}T00:00:00",
                "open": float(c[i]),
                "high": float(c[i] * 1.001),
                "low": float(c[i] * 0.999),
                "close": float(c[i]),
                "volume": 1000,
                "open_interest": 5000,
            }
            for i in range(len(c))
        ]

    bars_full = mk_bars(close)
    n_trunc = int(len(bars_full) * 0.8)
    bars_trunc = mk_bars(close[:n_trunc])
    for tokens in ([0], [0, 1, 64], [2, 64 + 13], [0, 64 + 21, 64 + 23]):
        f_full = execute(tokens, feature_matrix(bars_full))
        f_trunc = execute(tokens, feature_matrix(bars_trunc))
        assert f_full is not None and f_trunc is not None, f"{tokens} 执行失败"
        assert np.allclose(f_full[:n_trunc], f_trunc, atol=0, rtol=0), (
            f"{tokens} 前缀因子随未来数据变化——存在前视"
        )


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"[OK] {fn.__name__}")
    print(f"全部通过 ✔ ({len(tests)} 项)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
