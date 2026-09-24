"""因子策略 —— 本地桩(动态委托到 numpy 实现)

真实实现在 strategies/factor_np.py(服务端逐字移植,依赖 numpy,
只随因子内核加载)。本桩在基础内核(无 numpy)下保持可导入:
- 因子内核已加载时,委托调用真实实现(本地回测/信号计算完整可用);
- 未加载时给出可操作的错误提示而非栈崩溃。

此前直接 raise ValueError("暂不支持本地运行")是因子下沉的临时桩,
用户从超级因子挖掘挂任务后本地一回测即撞桩——本次真正下沉。
"""

from __future__ import annotations

from typing import Any


def _real():
    from strategies import factor_np

    return factor_np


def normalize_factor_params(params: dict[str, Any] | None) -> dict[str, Any]:
    try:
        return _real().normalize_factor_params(params)
    except ImportError:
        return dict(params or {})


def factor_snapshot(*args: Any, **kwargs: Any) -> dict[str, Any]:
    try:
        return _real().factor_snapshot(*args, **kwargs)
    except ImportError:
        return {}


def compute_factor_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    try:
        real = _real()
    except ImportError:
        raise ValueError(
            "factor 策略本地运行需要因子内核(numpy):"
            "请重试(首次会自动下载),或改用服务端引擎"
        )
    return real.compute_factor_signal(bars, params, side_mode, position)
