"""factor registry v3 访问与校验(方案任务 6 §9.2-2/3)

静态元数据来自 registry_data.py(由 schemas/factor-registry-v3.json 生成,
勿手改)。本模块只提供访问与校验;计算函数在 ops.py 单独实现。

校验纪律(§9.2-3):AST 只允许白名单节点和有界参数;禁止 eval/任意
Python;固定最大深度、节点数和累计历史需求——非法式在进入热循环前被
拒绝(返回违规清单,不抛异常;调用方决定处置)。
"""

from __future__ import annotations

from typing import Any

from .registry_data import (
    FEATURES,
    LIMITS,
    OPERATORS,
    OUTPUT_MAPPINGS,
    REGISTRY_HASH,
    REGISTRY_VERSION,
)

FEATURE_BY_NAME = {f["name"]: f for f in FEATURES}
OPERATOR_BY_NAME = {o["name"]: o for o in OPERATORS}
FEATURE_BY_CANONICAL_ID = {f["canonicalId"]: f for f in FEATURES}

EXPRESSION_VERSION = 3
SUPPORTED_PROFILES = ("crypto_local_v2",)


class RegistryError(ValueError):
    """注册表校验失败(带违规清单)"""


def lookback_of_param(expr: str, params: dict[str, int]) -> int:
    """求值 lookback 表达式:"0" | "<param>" | "<param>-1"(受限文法)。"""
    expr = str(expr).strip()
    if expr == "0":
        return 0
    if expr in params:
        return int(params[expr])
    if expr.endswith("-1") and expr[:-2].strip() in params:
        return int(params[expr[:-2].strip()]) - 1
    raise RegistryError(f"无法求值 lookback 表达式: {expr!r}")


def node_lookback(node: dict[str, Any]) -> int:
    """节点自身 lookback(不含子树;串联累计由 ast_lookback 递归)。"""
    if "feature" in node:
        feat = FEATURE_BY_NAME.get(node["feature"])
        if feat is None:
            return 0
        lb = int(feat["lookbackBars"])
        lag = int((node.get("params") or {}).get("lagBars") or 0)
        return lb + lag
    op = OPERATOR_BY_NAME.get(node.get("op") or "")
    if op is None:
        return 0
    return lookback_of_param(op["lookbackExpr"], dict(node.get("params") or {}))


def ast_lookback(node: dict[str, Any]) -> int:
    """累计历史需求:串联(嵌套)时子树 lookback 与本节点 lookback 相加
    (方案 5.2-2:串联累加、并联取最大——二元节点的两个分支是并联)。"""
    children = node.get("args") or []
    child_lb = max((ast_lookback(c) for c in children), default=0)
    return node_lookback(node) + child_lb


def ast_depth(node: dict[str, Any]) -> int:
    children = node.get("args") or []
    return 1 + max((ast_depth(c) for c in children), default=0)


def ast_node_count(node: dict[str, Any]) -> int:
    children = node.get("args") or []
    return 1 + sum(ast_node_count(c) for c in children)


def _validate_node(node: Any, errors: list[str], path: str) -> None:
    if not isinstance(node, dict):
        errors.append(f"{path}: 节点必须是对象")
        return
    if "feature" in node:
        name = node.get("feature")
        feat = FEATURE_BY_NAME.get(str(name))
        if feat is None:
            errors.append(f"{path}: 未知特征 {name!r}(白名单外)")
            return
        extra = set((node.get("params") or {}).keys()) - {p["name"] for p in feat["params"]}
        if extra:
            errors.append(f"{path}: 特征 {name} 不接受参数 {sorted(extra)}")
        for p in feat["params"]:
            v = (node.get("params") or {}).get(p["name"])
            if v is None:
                if p.get("default") is None:
                    errors.append(f"{path}: 缺必填参数 {p['name']}")
                continue
            if not isinstance(v, int) or v not in p["enum"]:
                errors.append(f"{path}: 参数 {p['name']}={v!r} 不在枚举 {p['enum']}")
        if node.get("args"):
            errors.append(f"{path}: 特征节点不得有 args")
        return
    op_name = node.get("op")
    op = OPERATOR_BY_NAME.get(str(op_name))
    if op is None:
        errors.append(f"{path}: 未知算子 {op_name!r}(白名单外)")
        return
    params = node.get("params") or {}
    if not isinstance(params, dict):
        errors.append(f"{path}: params 必须是对象")
        return
    extra = set(params.keys()) - {p["name"] for p in op["params"]}
    if extra:
        errors.append(f"{path}: 算子 {op_name} 不接受参数 {sorted(extra)}")
    for p in op["params"]:
        v = params.get(p["name"])
        if v is None:
            if p.get("default") is None and p.get("required"):
                errors.append(f"{path}: 算子 {op_name} 缺必填参数 {p['name']}")
            continue
        if not isinstance(v, int) or isinstance(v, bool) or v not in p["enum"]:
            errors.append(f"{path}: 算子 {op_name} 参数 {p['name']}={v!r} 不在枚举 {p['enum']}")
    args = node.get("args")
    if not isinstance(args, list) or len(args) != int(op["arity"]):
        errors.append(f"{path}: 算子 {op_name} 需要 {op['arity']} 个参数节点,得到 {len(args) if isinstance(args, list) else type(args).__name__}")
        return
    for i, child in enumerate(args):
        _validate_node(child, errors, f"{path}.args[{i}]")


def validate_expression(expr: dict[str, Any]) -> list[str]:
    """校验 v3 表达式外层与 AST;返回违规清单(空 = 合法)。

    外层契约:{version:3, profile, registryVersion?, root, outputMapping?}
    未知 version/profile/字段拒绝——不静默走旧执行器(§9.2-1)。
    """
    errors: list[str] = []
    if not isinstance(expr, dict):
        return ["表达式必须是对象"]
    version = expr.get("version")
    if version != EXPRESSION_VERSION:
        errors.append(f"未知表达式版本 {version!r}:v3 要求 version=3(不猜测整数范围)")
        return errors
    profile = expr.get("profile")
    if profile not in SUPPORTED_PROFILES:
        errors.append(f"profile {profile!r} 不支持 v3(支持: {', '.join(SUPPORTED_PROFILES)})")
    regv = expr.get("registryVersion")
    if regv is not None and regv != REGISTRY_VERSION:
        errors.append(f"registryVersion 不匹配:公式 {regv} vs 当前 {REGISTRY_VERSION}")
    om = expr.get("outputMapping")
    if om is not None and om not in OUTPUT_MAPPINGS:
        errors.append(f"未知 outputMapping {om!r}(支持: {', '.join(OUTPUT_MAPPINGS)})")
    known_top = {"version", "profile", "registryVersion", "root", "outputMapping"}
    extra_top = set(expr.keys()) - known_top
    if extra_top:
        errors.append(f"表达式外层未知字段: {sorted(extra_top)}")
    root = expr.get("root")
    if root is None:
        errors.append("缺 root 节点")
        return errors
    _validate_node(root, errors, "root")
    if not errors:
        depth = ast_depth(root)
        if depth > int(LIMITS["maxDepth"]):
            errors.append(f"深度 {depth} 超限(≤{LIMITS['maxDepth']})")
        count = ast_node_count(root)
        if count > int(LIMITS["maxNodes"]):
            errors.append(f"节点数 {count} 超限(≤{LIMITS['maxNodes']})")
        lb = ast_lookback(root)
        if lb > int(LIMITS["maxCumulativeLookback"]):
            errors.append(f"累计 lookback {lb} 超限(≤{LIMITS['maxCumulativeLookback']})")
    return errors


def gpu_supported(expr: dict[str, Any]) -> bool:
    """v3 表达式当前是否可走 GPU。

    首版一律 False:GPU v3 instruction buffer(opcode/operand/parameter
    index)未上线,能力协商把 v3 全部路由到 CPU(§9.2-4)。算子级 gpu
    标志是注册表元数据,供未来 WGSL 编译器上线后启用,当前不作执行依据。
    """
    return False


def required_fields(expr: dict[str, Any]) -> set[str]:
    """表达式依赖的原始 bar 字段(数据能力预检)。"""
    out: set[str] = set()

    def _walk(node: dict[str, Any]) -> None:
        feat = FEATURE_BY_NAME.get(node.get("feature") or "")
        if feat:
            out.update(feat["requiredFields"])
        for child in node.get("args") or []:
            _walk(child)

    try:
        _walk(expr["root"])
    except (KeyError, TypeError):
        pass
    return out
