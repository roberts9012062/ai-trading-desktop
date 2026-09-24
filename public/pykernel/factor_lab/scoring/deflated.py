"""Deflated Sharpe Ratio —— 按试验次数折扣的显著性概率（桌面端本地增强）

样本内最优因子是 trials 次尝试里的最大值：即便全部候选真实 Sharpe 为 0，
取最大值也会得到显著为正的样本内 Sharpe。DSR（Bailey & López de Prado 2014）
给出"扣除多重检验选择偏差后，真实 Sharpe > 0"的概率：

    SR0 = σ_null · [(1-γ)·Φ⁻¹(1-1/N) + γ·Φ⁻¹(1-1/(N·e))]
    DSR = Φ( (SR - SR0)·√(T-1) / √(1 - skew·SR + (kurt-1)/4·SR²) )

σ_null 取零假设下单期 Sharpe 估计的标准误 1/√(T-1)（原文用各试验 SR 的
截面方差；此处没有逐试验 SR，GP 候选高度相关，用 N=trials 偏保守）。
纯报告指标：不进适应度、不进严格筛。
"""

from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np

_EULER_GAMMA = 0.5772156649015329
_ND = NormalDist()


def expected_max_sharpe(trials: int, t: int) -> float:
    """零假设下 N 次试验最大单期 Sharpe 的期望（SR0）"""
    if trials <= 1 or t <= 1:
        return 0.0
    n = float(trials)
    emax = (1.0 - _EULER_GAMMA) * _ND.inv_cdf(1.0 - 1.0 / n) + _EULER_GAMMA * _ND.inv_cdf(
        1.0 - 1.0 / (n * math.e)
    )
    return emax / math.sqrt(t - 1)


def deflated_sharpe(pnl: np.ndarray, trials: int) -> float | None:
    """pnl 序列的 DSR ∈ [0,1]；样本过短或零波动返回 None"""
    pnl = np.asarray(pnl, dtype=float)
    t = len(pnl)
    if t < 30:
        return None
    sd = float(pnl.std())
    if sd < 1e-12:
        return None
    sr = float(pnl.mean()) / sd
    z = (pnl - pnl.mean()) / sd
    skew = float((z ** 3).mean())
    kurt = float((z ** 4).mean())
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr
    if denom <= 1e-12:
        return None
    sr0 = expected_max_sharpe(int(trials), t)
    return float(_ND.cdf((sr - sr0) * math.sqrt(t - 1) / math.sqrt(denom)))
