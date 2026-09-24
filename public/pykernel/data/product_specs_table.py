"""期货品种默认规格数据表汇总"""

from __future__ import annotations

from typing import Any

from data.product_specs_other import SPECS as _OTHER
from data.product_specs_shfe_dce import SPECS as _SHFE_DCE

ProductSpec = dict[str, Any]

DEFAULT_SPEC: ProductSpec = {
    "code": "DEFAULT",
    "name": "默认",
    "multiplier": 10,
    "margin_rate": 0.12,
    "fee_mode": "rate",
    "open_fee": 0.0001,
    "close_fee": 0.0001,
    "tick_size": 1.0,
}

PRODUCT_SPECS: dict[str, ProductSpec] = {}
PRODUCT_SPECS.update(_SHFE_DCE)
PRODUCT_SPECS.update(_OTHER)
