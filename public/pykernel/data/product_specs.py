"""品种规格入口（转发至 specs 子包）"""

from data.specs_product_specs import (
    extract_product_code,
    get_product_spec,
    list_all_product_specs,
)

__all__ = [
    "extract_product_code",
    "get_product_spec",
    "list_all_product_specs",
]
