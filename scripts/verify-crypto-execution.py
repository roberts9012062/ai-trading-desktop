"""执行成本与 funding 现金流回归(方案 §7 验收)

手算案例覆盖:
- 固定多仓/空仓:正费率多头付费、空头收款、零持仓零现金流;
- 结算瞬间换仓:同戳保守排序(先计费后成交);
- 一日多次结算:分别累计,只按事件原值;
- 缺失事件/标记价缺失:estimated/missing 标注,不冒充精确;
- 单边/双边成本:fee+slippage 数学;2×压力只放大交易成本不动 funding;
- 次根开盘执行:收益归属 open→open;
- 全段与分段现金流一致:切片不重计开仓成本;
- 前填费率不重复扣款:同 funding_time 多根 bar 只结算一次。

用法: python -X utf8 scripts/verify-crypto-execution.py
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

from factor_lab.scoring.execution import (  # noqa: E402
    ExecutionConfig,
    executable_cashflows,
    executable_metrics,
)
from factor_lab.scoring.funding import (  # noqa: E402
    FundingEvent,
    extract_funding_events,
    funding_cashflows,
)


def _mk_bars(opens: list[float], closes: list[float], funding=None, times=None) -> list:
    """opens/closes 价格序列;funding=[(funding_time_ms, rate, start_bar), ...]
    从 start_bar 起前填到下一事件(模拟 joinGateHistory 的已知事件前填)。
    bar i 的 open_time = (i+1)*3600_000(1h 网格,首根开盘 01:00)。"""
    n = len(opens)
    out = []
    for i in range(n):
        b = {
            "time": (times[i] if times else f"2026-01-{i // 24 + 1:02d}T{i % 24:02d}:00"),
            "open_time": (i + 1) * 3600_000,
            "open": float(opens[i]),
            "high": max(opens[i], closes[i]) * 1.01,
            "low": min(opens[i], closes[i]) * 0.99,
            "close": float(closes[i]),
            "volume": 10.0,
            "market_source": "gate_usdt",
        }
        out.append(b)
    if funding:
        for fi, (ft_ms, rate, start) in enumerate(funding):
            end = funding[fi + 1][2] if fi + 1 < len(funding) else n
            for j in range(start, min(end, n)):
                out[j]["funding_time"] = float(ft_ms)
                out[j]["funding_rate"] = float(rate)
    return out


def _flat_factor(n: int, level: float) -> np.ndarray:
    """常数因子:输出归一化后 tanh≈常数控件(直接给稳定值)"""
    return np.full(n, float(level))


class FundingHandCalcTests(unittest.TestCase):
    def test_long_pays_positive_rate(self):
        """多头 + 正费率 → 负现金流(付费);手算对照。"""
        bars = _mk_bars([100] * 12, [100] * 12, funding=[(8 * 3600_000, 0.0001, 1)])
        held = np.full(12, 0.5)  # 恒 0.5 多头
        out = funding_cashflows(bars, held, extract_funding_events(bars))
        # 事件 attach 在 bar 1(其 open_time=2*3600_000 > 8*3600_000? 否——
        # 事件 t=8h,首根 open_time=1h... 前填区间从 bar 8 起)
        self.assertEqual(out["n_events"], 1)
        # 手算:-0.5 × 1 × close[attach-1]=100 × 0.0001 = -0.005
        self.assertAlmostEqual(out["total"], -0.005, places=9)
        self.assertEqual(out["estimated"], 1)  # 标记价缺失→收盘估算

    def test_short_receives_positive_rate(self):
        """空头 + 正费率 → 正现金流(收款)。"""
        bars = _mk_bars([100] * 12, [100] * 12, funding=[(8 * 3600_000, 0.0001, 1)])
        held = np.full(12, -0.5)
        out = funding_cashflows(bars, held, extract_funding_events(bars))
        self.assertAlmostEqual(out["total"], +0.005, places=9)

    def test_zero_position_zero_cashflow(self):
        bars = _mk_bars([100] * 12, [100] * 12, funding=[(8 * 3600_000, 0.0001, 1)])
        held = np.zeros(12)
        out = funding_cashflows(bars, held, extract_funding_events(bars))
        self.assertEqual(out["total"], 0.0)
        self.assertEqual(out["n_events"], 1)  # 事件存在但零持仓

    def test_settlement_instant_rebalance_conservative_order(self):
        """结算与换仓同戳:先按结算前持仓计费,再处理新订单。"""
        bars = _mk_bars([100] * 12, [100] * 12)
        # 事件恰在 bar 8 开盘时刻(settle 前仓位 0.2,订单后 0.8)
        ev = FundingEvent(settled_at_ms=8 * 3600_000, rate=0.001, attach_bar=8)
        held = np.full(12, 0.2)
        held[8:] = 0.8
        out = funding_cashflows(bars, held, [ev])
        # 手算:-0.2 × 100 × 0.001 = -0.02(不是 -0.08)
        self.assertAlmostEqual(out["total"], -0.02, places=9)

    def test_multiple_settlements_same_bar_accumulate(self):
        """一日多次结算:同 bar 多事件分别累计(日线只带最后一个——
        现金流层支持多事件,数据层覆盖由 coverage 标注)。"""
        bars = _mk_bars([100] * 12, [100] * 12)
        ev1 = FundingEvent(settled_at_ms=8 * 3600_000 + 1, rate=0.0001, attach_bar=8)
        ev2 = FundingEvent(settled_at_ms=8 * 3600_000 + 2, rate=0.0002, attach_bar=8)
        held = np.full(12, 1.0)
        out = funding_cashflows(bars, held, [ev1, ev2])
        # 手算:-(1×100×0.0001 + 1×100×0.0002) = -0.03
        self.assertAlmostEqual(out["total"], -0.03, places=9)
        self.assertEqual(out["n_events"], 2)

    def test_ffill_not_double_charged(self):
        """前填不重复扣款:同 funding_time 的 8 根 bar 只有 1 次结算。"""
        bars = _mk_bars([100] * 24, [100] * 24, funding=[(0, 0.0001, 0), (8 * 3600_000, 0.0002, 8)])
        events = extract_funding_events(bars)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].attach_bar, 0)
        self.assertEqual(events[1].attach_bar, 8)

    def test_missing_events_reported(self):
        """缺失:首根 attach 无法估算 → missing 计数,不冒充 0 结算。"""
        bars = _mk_bars([100] * 4, [100] * 4)
        ev = FundingEvent(settled_at_ms=0.5 * 3600_000, rate=0.001, attach_bar=0)
        out = funding_cashflows(bars, np.ones(4), [ev])
        self.assertEqual(out["missing"], 1)
        self.assertEqual(out["total"], 0.0)


class ExecutionModelTests(unittest.TestCase):
    CFG = ExecutionConfig(fee_rate=0.001, slippage_bps=0.0, execution_model="perp_next_open")

    def test_next_open_return_attribution(self):
        """次根开盘成交:信号 bar 0 收盘 → bar 1 开盘进 → bar 2 开盘出。"""
        # 开盘价 100,101,102,...:每根 open→open 收益 1%
        opens = [100 * 1.01 ** i for i in range(6)]
        bars = _mk_bars(opens, opens)
        factor = _flat_factor(6, 3.0)  # 强信号→tanh≈1 满仓
        flows = executable_cashflows(factor, bars, self.CFG)
        self.assertIsNotNone(flows)
        # held[0]=0(首根无仓);held[1]=sig[0]≈1
        self.assertAlmostEqual(flows["held"][0], 0.0, places=9)
        self.assertGreater(flows["held"][1], 0.76)  # tanh(3)≈0.995
        # pnl[1] = held[1] × (open[2]-open[1])/open[1] - fee[1]
        expected = flows["held"][1] * 0.01 - abs(flows["held"][1] - 0.0) * self.CFG.unit_cost
        self.assertAlmostEqual(flows["pnl"][1], expected, places=12)
        # 末根无完整 open→open 区间 → price_ret=0,只可能有 funding
        self.assertEqual(flows["pnl"][-1], -flows["fee"][-1] + flows["funding_cf"][-1])

    def test_fee_slippage_math_and_stress(self):
        """单边/双边成本:进出各计一次;2× 压力只放大 fee 不动 funding。"""
        opens = [100.0] * 8
        bars = _mk_bars(opens, opens, funding=[(0, 0.0001, 1)])
        factor = np.array([3.0, 3.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0])  # 开→平→开
        base = executable_cashflows(
            factor, bars, ExecutionConfig(fee_rate=0.001, slippage_bps=5.0)
        )
        unit = 0.001 + 5.0 * 1e-4
        sig = np.tanh(np.clip(factor, -3, 3))
        sig[np.abs(sig) < 0.05] = 0.0
        # fee[1]=|sig0-0|·unit(开), fee[3]=|sig2-sig1|·unit(平), fee[5]=|sig4-sig3|·unit(开)
        self.assertAlmostEqual(base["fee"][1], sig[0] * unit, places=12)
        self.assertAlmostEqual(base["fee"][3], sig[1] * unit, places=12)
        self.assertAlmostEqual(base["fee"][5], sig[3 + 1] * unit, places=12)
        self.assertAlmostEqual(base["fee"][0], 0.0, places=12)
        stressed = executable_cashflows(
            factor, bars, ExecutionConfig(fee_rate=0.001, slippage_bps=5.0, stress_multiplier=2.0)
        )
        self.assertAlmostEqual(stressed["fee"][1], base["fee"][1] * 2, places=12)
        self.assertAlmostEqual(stressed["funding_cf"].sum(), base["funding_cf"].sum(), places=12)

    def test_full_vs_slice_consistency(self):
        """全段与分段一致:验证段切片 = 全段同区间(不重计开仓成本)。"""
        rng = np.random.default_rng(9)
        opens = list(100.0 * np.cumprod(1 + rng.normal(0, 0.01, 60)))
        closes = list(np.array(opens) * (1 + rng.normal(0, 0.003, 60)))
        bars = _mk_bars(opens, closes, funding=[(i * 8 * 3600_000, 0.0001 + 1e-5 * i, i * 8) for i in range(7)])
        factor = rng.normal(0, 1, 60)
        full = executable_cashflows(factor, bars, self.CFG)
        # 分段:上下文含训练段,只报验证段 [40, 56)
        m_full = executable_metrics(factor, bars, "60m", self.CFG, lo=40, hi=56)
        self.assertIsNotNone(m_full)
        pnl_slice = full["pnl"][40:56]
        from factor_lab.scoring.periods import bars_per_year

        periods_slice = bars_per_year(bars[40:56], "60m")
        self.assertAlmostEqual(
            m_full["ann_ret"], float(pnl_slice.mean() * periods_slice), places=9
        )
        self.assertAlmostEqual(m_full["fee_total"], float(full["fee"][40:56].sum()), places=12)
        self.assertAlmostEqual(m_full["funding_total"], float(full["funding_cf"][40:56].sum()), places=12)
        # 切片起点不因"重新从空仓启动"多收一笔开仓费:
        self.assertAlmostEqual(m_full["fee_total"], float(full["fee"][40:56].sum()), places=12)

    def test_spot_long_flat_clips_short(self):
        """现货 long_flat:负仓位截断为 0,不输出做空现金流。"""
        opens = [100.0] * 6
        bars = _mk_bars(opens, opens)
        factor = np.array([-3.0] * 6)
        cfg = ExecutionConfig(execution_model="spot_long_flat")
        flows = executable_cashflows(factor, bars, cfg)
        self.assertTrue(np.all(flows["held"] <= 1e-12), "现货不得持有空头")
        long_cfg = ExecutionConfig(execution_model="perp_next_open")
        flows2 = executable_cashflows(factor, bars, long_cfg)
        self.assertTrue(np.all(flows2["held"][1:] < 0), "永续可持空头(对照;held[0] 恒为 0)")

    def test_perp_without_funding_data_flagged(self):
        """perp 但无 funding 数据:no_funding_data 显式标注(关键成本未知)。"""
        bars = _mk_bars([100.0] * 6, [100.0] * 6)  # 无 funding 字段
        flows = executable_cashflows(_flat_factor(6, 2.0), bars, self.CFG)
        self.assertTrue(flows["no_funding_data"])
        self.assertEqual(flows["n_funding_events"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
