"""强弱值特征 —— 图表强弱指标主值同口径（复用 signal_strength 内核）

强弱值（0-100，一次平滑主序列收盘）映射到 [-1, 1]（同 RSI14 的处理），
再随价量特征统一走因果 zscore。三档进场信号语义见策略层
ai_trading/strategies/strength_entry.py；本特征只暴露数值序列供因子
公式挖掘（IC 评估），不含信号语义。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..signal_strength import DEFAULT_STRENGTH_PARAMS, calc_strength

# 因子语境用默认参数（14/3/1/10）：与图表默认副图一致，保证特征语义
# 与用户所见曲线同源；挖掘侧如需自定义窗口应另立特征名（append-only）
_PARAMS = DEFAULT_STRENGTH_PARAMS


def strength_series(bars: list[dict[str, Any]]) -> np.ndarray:
    """强弱主值序列映射到 [-1, 1]：0 → -1，100 → +1

    窗口不满（bars 少于 period 根）时无输出，头部补 0（与其它特征
    的头部置零惯例一致，zscore 后不产生假信号）。
    """
    res = calc_strength(bars, _PARAMS)
    out = np.zeros(len(bars), dtype=float)
    first = int(_PARAMS["period"]) - 1
    points = res["points"]
    for k, point in enumerate(points):
        # 输出点取二次平滑序列；smooth2=1（默认）时与主序列位级相同
        out[first + k] = float(point["close"]) / 50.0 - 1.0
    return out
