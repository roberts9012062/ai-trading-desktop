"""期货品种交易规格查询 —— 默认值加载与合并"""

from __future__ import annotations

from typing import Any

from data.contracts import get_code_for_symbol
from data.product_specs_table import DEFAULT_SPEC, PRODUCT_SPECS

ProductSpec = dict[str, Any]


def extract_product_code(symbol: str) -> str:
    """从合约代码提取品种代码（如 rb2610 → RB）"""
    symbol_l = symbol.strip().lower()
    code = get_code_for_symbol(symbol_l)
    if code:
        return code.upper()
    letters = "".join(ch for ch in symbol_l if ch.isalpha())
    return letters.upper() if letters else "DEFAULT"


def get_product_spec(symbol_or_code: str) -> ProductSpec:
    """获取品种规格（含兜底合并）"""
    raw = symbol_or_code.strip()
    code = raw.upper() if raw.isalpha() else extract_product_code(raw)
    base = PRODUCT_SPECS.get(code)
    if base is None:
        result = dict(DEFAULT_SPEC)
        result["code"] = code if code else "DEFAULT"
        return result
    result = dict(DEFAULT_SPEC)
    result.update(base)
    result["code"] = code
    return result


def list_all_product_specs() -> list[ProductSpec]:
    """列出全部已配置品种规格"""
    items: list[ProductSpec] = []
    for code, spec in sorted(PRODUCT_SPECS.items()):
        item = dict(DEFAULT_SPEC)
        item.update(spec)
        item["code"] = code
        items.append(item)
    return items
