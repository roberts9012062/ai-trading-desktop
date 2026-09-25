"""量化规则策略包"""

from strategies.band_swing import (
    compute_band_swing_signal,
    normalize_band_params,
)
from strategies.factor import (
    compute_factor_signal,
    factor_snapshot,
    normalize_factor_params,
)
from strategies.kdj_cross import (
    compute_kdj_cross_signal,
    normalize_kdj_params,
)
from strategies.ma_cross import (
    compute_ma_cross_signal,
    normalize_ma_params,
)
from strategies.macd_cross import (
    compute_macd_cross_signal,
    normalize_macd_params,
)
from strategies.n_breakout import (
    compute_n_breakout_signal,
    normalize_breakout_params,
)
from strategies.swing_pivot import (
    compute_swing_pivot_signal,
    normalize_swing_pivot_params,
)

# 纯量化策略类型（不含 ai）
QUANT_STRATEGY_TYPES: tuple[str, ...] = (
    "ma_cross",
    "n_breakout",
    "macd_cross",
    "kdj_cross",
    "band_swing",
    "swing_pivot",
    "factor",
)

STRATEGY_LABELS: dict[str, str] = {
    "n_breakout": "量化 · N 日突破",
    "ma_cross": "量化 · 双均线",
    "macd_cross": "量化 · MACD 金叉死叉",
    "kdj_cross": "量化 · KDJ 金叉死叉",
    "band_swing": "量化 · 布林带波段",
    "swing_pivot": "量化 · 枢轴波段",
    "factor": "量化 · 因子公式",
    "ai": "AI 自动交易（抽样调用）",
}


def normalize_strategy_params(
    strategy_type: str,
    raw: dict | None,
) -> dict:
    """按策略类型规范化参数"""
    st = str(strategy_type or "").strip().lower()
    if st == "ma_cross":
        return normalize_ma_params(raw)
    if st == "n_breakout":
        return normalize_breakout_params(raw)
    if st == "macd_cross":
        return normalize_macd_params(raw)
    if st == "kdj_cross":
        return normalize_kdj_params(raw)
    if st == "band_swing":
        return normalize_band_params(raw)
    if st == "swing_pivot":
        return normalize_swing_pivot_params(raw)
    if st == "factor":
        return normalize_factor_params(raw)
    return dict(raw or {})


def compute_quant_signal(
    strategy_type: str,
    bars: list,
    params: dict,
    side_mode: str,
    position: dict | None,
) -> dict:
    """分发量化信号计算"""
    st = str(strategy_type or "").strip().lower()
    if st == "ma_cross":
        return compute_ma_cross_signal(bars, params, side_mode, position)
    if st == "n_breakout":
        return compute_n_breakout_signal(bars, params, side_mode, position)
    if st == "macd_cross":
        return compute_macd_cross_signal(bars, params, side_mode, position)
    if st == "kdj_cross":
        return compute_kdj_cross_signal(bars, params, side_mode, position)
    if st == "band_swing":
        return compute_band_swing_signal(bars, params, side_mode, position)
    if st == "swing_pivot":
        return compute_swing_pivot_signal(bars, params, side_mode, position)
    if st == "factor":
        return compute_factor_signal(bars, params, side_mode, position)
    return {
        "action": "hold",
        "quantity": 0,
        "reason": f"不支持的量化策略: {st}",
        "confidence": 0,
        "parse_ok": True,
    }


__all__ = [
    "QUANT_STRATEGY_TYPES",
    "STRATEGY_LABELS",
    "compute_quant_signal",
    "normalize_strategy_params",
    "compute_ma_cross_signal",
    "normalize_ma_params",
    "compute_n_breakout_signal",
    "normalize_breakout_params",
    "compute_macd_cross_signal",
    "normalize_macd_params",
    "compute_kdj_cross_signal",
    "normalize_kdj_params",
    "compute_band_swing_signal",
    "normalize_band_params",
    "compute_swing_pivot_signal",
    "normalize_swing_pivot_params",
    "compute_factor_signal",
    "normalize_factor_params",
    "factor_snapshot",
]
