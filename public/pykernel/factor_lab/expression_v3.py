"""v3 表达式:显式 AST/IR 的解析、编译与 CPU 执行(方案任务 6 §9.2)

与 v2 的关系:
- v2 的 number[] token 继续由 StackVM 旧解码器处理;v3 必须携带显式
  version=3 和 AST——不猜测整数范围,不向旧服务端发送伪造 v2 tokens;
- v2 特征 0-63 / 算子 offset=64 永久冻结;v3 的参数化窗口(同算子不同
  windowBars)不占用任何 v2 id 空间;
- 参数的物理时长在创建公式时编译为明确整数 bars 并保存(§9.2-7):同一
  公式不随当前页面周期静默变义;跨周期迁移生成新表达式(哈希不同)。

首版 CPU 执行(GPU instruction buffer 未上线,能力协商一律走 CPU);
输出归一化沿用研究契约:profile=crypto_local_v2 → 严格因果路径。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np

from .ops import (
    OPS_CONFIG,
    _ema,
    _lag,
    _ts_demean,
    delta,
    rolling_winsor,
    robust_zscore,
    ts_beta,
    ts_centered_rank,
    ts_corr,
    ts_decay_linear,
    ts_max,
    ts_mean,
    ts_min,
    ts_rank,
    ts_resid,
    ts_std,
    ts_zscore,
)
from .registry import (
    FEATURE_BY_NAME,
    OPERATOR_BY_NAME,
    RegistryError,
    validate_expression,
)
from .registry_data import REGISTRY_VERSION
from .vm import NORM_CAUSAL_V2, _normalize_output, execute as vm_execute

EXPRESSION_VERSION = 3

# v3 算子名 → 执行函数(参数 windowBars/nBars 由节点 params 绑定)
_OP_IMPL = {
    "ts_mean": lambda x, w: ts_mean(x, w),
    "ts_std": lambda x, w: ts_std(x, w),
    "ts_zscore": lambda x, w: ts_zscore(x, w),
    "ts_rank": lambda x, w: ts_rank(x, w),
    "ts_crank": lambda x, w: ts_centered_rank(x, w),
    "ts_max": lambda x, w: ts_max(x, w),
    "ts_min": lambda x, w: ts_min(x, w),
    "demean": lambda x, w: _ts_demean(x, w),
    "delta": lambda x, n: delta(x, n),
    "lag": lambda x, n: _lag(x, n),
    "decay_linear": lambda x, w: ts_decay_linear(x, w),
    "ema": lambda x, w: _ema(x, w),
    "robust_zscore": lambda x, w: robust_zscore(x, w),
    "winsor": lambda x, w: rolling_winsor(x, w),
    "ts_corr": lambda a, b, w: ts_corr(a, b, w),
    "ts_beta": lambda a, b, w: ts_beta(a, b, w),
    "resid": lambda a, b, w: ts_resid(a, b, w),
}

# 初等算子复用 v2 OPS_CONFIG 的实现(名字大写映射)
_V2_OP_BY_NAME = {name: idx for idx, (name, _fn, _arity) in enumerate(OPS_CONFIG)}


def canonical_json(value: Any) -> str:
    """确定性序列化:键排序 + 紧凑(哈希/往返的基础)。"""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalize_expression(expr: dict[str, Any]) -> dict[str, Any]:
    """规范化外层:补 registryVersion/outputMapping 默认,参数按声明排序。"""
    root = _normalize_node(expr["root"])
    out = {
        "version": EXPRESSION_VERSION,
        "profile": expr.get("profile") or "crypto_local_v2",
        "registryVersion": REGISTRY_VERSION,
        "outputMapping": expr.get("outputMapping") or "rolling_zscore",
        "root": root,
    }
    return out


def _normalize_node(node: dict[str, Any]) -> dict[str, Any]:
    if "feature" in node:
        feat = FEATURE_BY_NAME[node["feature"]]
        params = {
            p["name"]: int((node.get("params") or {}).get(p["name"], p.get("default")))
            for p in feat["params"]
            if (node.get("params") or {}).get(p["name"], p.get("default")) is not None
        }
        return {"feature": feat["name"], **({"params": params} if params else {})}
    op = OPERATOR_BY_NAME[node["op"]]
    params = {
        p["name"]: int(node["params"][p["name"]])
        for p in op["params"]
        if p["name"] in (node.get("params") or {})
    }
    defaults = {p["name"]: p["default"] for p in op["params"] if p.get("default") is not None}
    merged = {**defaults, **params}
    args = [_normalize_node(c) for c in node.get("args") or []]
    return {
        "op": op["name"],
        **({"params": merged} if merged else {}),
        "args": args,
    }


def expression_hash(expr: dict[str, Any]) -> str:
    """公式哈希:canonical(normalized AST)的 SHA-256 前 16 位。

    同文本不同 windowBars 的公式哈希不同(§9.2 验收);registryVersion
    计入哈希(注册表演进改变公式身份)。
    """
    return hashlib.sha256(canonical_json(normalize_expression(expr)).encode()).hexdigest()[:16]


def to_text(expr: dict[str, Any]) -> str:
    """人读公式文本(参数显式:ts_mean(RET, 20))。"""

    def _render(node: dict[str, Any]) -> str:
        if "feature" in node:
            name = node["feature"]
            params = node.get("params") or {}
            return name if not params else f"{name}[{','.join(f'{k}={v}' for k, v in sorted(params.items()))}]"
        op = OPERATOR_BY_NAME[node["op"]]
        rendered_args = ",".join(_render(c) for c in node.get("args") or [])
        params = node.get("params") or {}
        ptxt = "," + ",".join(f"{k}={v}" for k, v in sorted(params.items())) if params else ""
        return f"{op['name']}({rendered_args}{ptxt})"

    try:
        return _render(expr["root"])
    except (KeyError, TypeError):
        return "<invalid-v3>"


def compile_window_bars(physical_hours: int, timeframe: str) -> int:
    """物理时长 → 明确整数 bars(§9.2-7:创建公式时编译并保存)。

    intraday 周期:bars = ceil(hours / 每根小时数),至少 2 根;
    1d 周期:bars = ceil(hours / 24),至少 2 根;超出注册表窗口枚举的
    结果报错(不静默取整到别的语义)。
    """
    tf_minutes = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1h": 60, "1d": 1440}.get(timeframe)
    if tf_minutes is None:
        raise RegistryError(f"未知周期 {timeframe!r}")
    bars = -(-physical_hours * 60 // tf_minutes)
    if bars < 2:
        # 物理时长短于 2 根:不可表示。不静默钳位到 2(变义),显式拒绝;
        # 该时长应改用更细周期表达
        raise RegistryError(
            f"物理时长 {physical_hours}h 在 {timeframe} 下不足 2 根 bar,"
            f"无法表示(1 根的滚动窗口是退化的);请用更细周期"
        )
    allowed = sorted({w for o in OPERATOR_BY_NAME.values() for p in o["params"]
                      if p["name"] == "windowBars" for w in p["enum"]})
    if bars not in allowed:
        raise RegistryError(
            f"物理时长 {physical_hours}h 在 {timeframe} 下编译为 {bars} bars,"
            f"不在窗口枚举 {allowed};跨周期迁移应生成新实验而非取整变义"
        )
    return int(bars)


def _execute_node(
    node: dict[str, Any],
    feat_matrix: np.ndarray,
    v2_causal: bool,
    norm_window: int,
) -> np.ndarray:
    if "feature" in node:
        feat = FEATURE_BY_NAME[node["feature"]]
        row = int(feat["canonicalId"])
        if row >= feat_matrix.shape[0]:
            raise RegistryError(f"特征 {feat['name']} 不在当前特征矩阵(id {row} 越界)")
        series = feat_matrix[row]
        lag = int((node.get("params") or {}).get("lagBars") or 0)
        if lag > 1:
            series = _lag(series, lag)
        return np.asarray(series, dtype=float)
    op = OPERATOR_BY_NAME[node["op"]]
    params = dict(node.get("params") or {})
    args = [_execute_node(c, feat_matrix, v2_causal, norm_window) for c in node.get("args") or []]
    name = op["name"]
    if name in _OP_IMPL:
        fn = _OP_IMPL[name]
        if op["arity"] == 1:
            return np.asarray(fn(args[0], params.get("windowBars", params.get("nBars"))), dtype=float)
        return np.asarray(fn(args[0], args[1], params["windowBars"]), dtype=float)
    # 初等算子 → v2 实现(复用数学,单一事实源)
    v2_idx = _V2_OP_BY_NAME.get(name.upper())
    if v2_idx is None:
        raise RegistryError(f"算子 {name} 无 CPU 实现")
    _, fn, arity = OPS_CONFIG[v2_idx]
    res = fn(*args[:arity])
    return np.nan_to_num(np.asarray(res, dtype=float), nan=0.0, posinf=1.0, neginf=-1.0)


def execute_v3(
    expr: dict[str, Any],
    feat_matrix: np.ndarray,
    norm_window: int = 250,
) -> np.ndarray | None:
    """执行 v3 表达式;校验失败或求值异常返回 None(与 vm.execute 同契约)。

    输出归一化:outputMapping=rolling_zscore(默认)→ 与 v2 vm 相同的
    因果滚动 zscore + clip;preserve_signed_bounded → sigmoid 有界映射
    (不强行去均值——§5.2-8:绝对 funding 符号等经济含义不得在最后一层
    被 zscore 抹掉)。
    """
    errors = validate_expression(expr)
    if errors:
        return None
    try:
        node_out = _execute_node(expr["root"], feat_matrix, True, norm_window)
    except (RegistryError, ValueError, FloatingPointError, OverflowError):
        return None
    mapping = expr.get("outputMapping") or "rolling_zscore"
    if mapping == "preserve_signed_bounded":
        x = np.clip(np.asarray(node_out, dtype=float), -30, 30)
        return 2.0 / (1.0 + np.exp(-x)) - 1.0
    return _normalize_output(np.asarray(node_out, dtype=float), norm_window, causal=True)


def execute_v3_strict(expr: dict[str, Any], feat_matrix: np.ndarray, norm_window: int = 250) -> np.ndarray:
    """同 execute_v3,但校验失败抛 RegistryError(供入口层给明确报错)。"""
    errors = validate_expression(expr)
    if errors:
        raise RegistryError("v3 表达式非法: " + "; ".join(errors))
    out = execute_v3(expr, feat_matrix, norm_window)
    if out is None:
        raise RegistryError("v3 表达式求值失败(节点越界或数值异常)")
    return out


def to_v2_equivalent(expr: dict[str, Any]) -> list[int] | None:
    """尝试把 v3 表达式映射回等价的 v2 token 序列(黄金对拍/兼容导出用)。

    仅当:特征无参数(或 lagBars=1)、算子参数恰对应 v2 固定窗口条目时
    可映射;参数化超出 v2 固定窗口的(如 ts_mean w=60 可映射,ts_corr
    参数化窗口若 v2 无对应则 None)。返回 None = 无 v2 等价(不伪造)。
    """
    errors = validate_expression(expr)
    if errors:
        return None
    # v3 名 → v2 基名的别名(语义相同命名不同)
    v2_alias = {"ts_ma": "ts_mean"}
    window_to_v2: dict[tuple[str, int], str] = {}
    for name, _idx, _a in [(n, i, a) for i, (n, _f, a) in enumerate(OPS_CONFIG)]:
        # 从名字解析窗口:TS_MA_20 → ts_mean/20;DECAY_LINEAR_10 → decay_linear/10
        digits = "".join(ch for ch in name.split("_")[-1] if ch.isdigit())
        if not digits:
            continue
        base = name[: -len(digits) - 1] if name[: -len(digits) - 1].endswith("_" + digits) else name.rsplit("_", 1)[0]
        key = v2_alias.get(base.lower(), base.lower())
        window_to_v2.setdefault((key, int(digits)), name)
    v2_name_to_token = {name: 64 + idx for idx, (name, _f, _a) in enumerate(OPS_CONFIG)}
    special = {"demean": "TS_DEMEAN_20", "delta_1": "DELTA_1", "delta_5": "DELTA_5",
               "lag_1": "LAG_1", "lag_5": "LAG_5", "atr_norm": "TS_ATR_NORM",
               "robust_zscore_20": "ROBUST_ZSCORE_20", "winsor_20": "WINSOR_20",
               "ts_corr_20": "CORR_20", "ts_beta_20": "BETA_20", "resid_20": "RESID_20",
               "ts_crank_20": "TS_CRANK_20", "ts_crank_60": "TS_CRANK_60",
               "ema_5": "EMA_5", "ema_20": "EMA_20"}

    def _map(node: dict[str, Any]) -> list[int] | None:
        if "feature" in node:
            params = node.get("params") or {}
            if params and any(int(v) != 1 for v in params.values()):
                return None
            feat = FEATURE_BY_NAME[node["feature"]]
            return [int(feat["canonicalId"])]
        op = OPERATOR_BY_NAME[node["op"]]
        params = dict(node.get("params") or {})
        child_tokens: list[list[int]] = []
        for c in node.get("args") or []:
            t = _map(c)
            if t is None:
                return None
            child_tokens.append(t)
        name = op["name"]
        w = params.get("windowBars") or params.get("nBars")
        v2_name = None
        if not params:
            v2_name = name.upper()
        elif (name, int(w)) in window_to_v2:
            v2_name = window_to_v2[(name, int(w))]
        elif f"{name}_{int(w)}" in special:
            v2_name = special[f"{name}_{int(w)}"]
        if v2_name is None or v2_name not in v2_name_to_token:
            return None
        out: list[int] = []
        for t in child_tokens:
            out.extend(t)
        out.append(v2_name_to_token[v2_name])
        return out

    return _map(expr["root"])
