"""郑商所/中金所/广期所/能源 品种默认规格"""
from __future__ import annotations
from typing import Any
ProductSpec = dict[str, Any]
SPECS: dict[str, ProductSpec] = {
    "AP": {'name': '苹果', 'multiplier': 10, 'margin_rate': 0.1, 'fee_mode': 'fixed', 'open_fee': 5.0, 'close_fee': 5.0},
    "BC": {'name': '国际铜', 'multiplier': 5, 'margin_rate': 0.1, 'fee_mode': 'rate', 'open_fee': 1e-05, 'close_fee': 1e-05},
    "CF": {'name': '棉花', 'multiplier': 5, 'margin_rate': 0.09, 'fee_mode': 'rate', 'open_fee': 4.35e-05, 'close_fee': 4.35e-05},
    "FG": {'name': '玻璃', 'multiplier': 20, 'margin_rate': 0.1, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
    "IC": {'name': '中证500股指', 'multiplier': 200, 'margin_rate': 0.14, 'fee_mode': 'rate', 'open_fee': 2.3e-05, 'close_fee': 2.3e-05},
    "IF": {'name': '沪深300股指', 'multiplier': 300, 'margin_rate': 0.12, 'fee_mode': 'rate', 'open_fee': 2.3e-05, 'close_fee': 2.3e-05},
    "IH": {'name': '上证50股指', 'multiplier': 300, 'margin_rate': 0.12, 'fee_mode': 'rate', 'open_fee': 2.3e-05, 'close_fee': 2.3e-05},
    "IM": {'name': '中证1000股指', 'multiplier': 200, 'margin_rate': 0.14, 'fee_mode': 'rate', 'open_fee': 2.3e-05, 'close_fee': 2.3e-05},
    "LC": {'name': '碳酸锂', 'multiplier': 1, 'margin_rate': 0.12, 'fee_mode': 'rate', 'open_fee': 8e-05, 'close_fee': 8e-05},
    "LU": {'name': '低硫燃油', 'multiplier': 10, 'margin_rate': 0.1, 'fee_mode': 'rate', 'open_fee': 0.0001, 'close_fee': 0.0001},
    "MA": {'name': '甲醇', 'multiplier': 10, 'margin_rate': 0.09, 'fee_mode': 'fixed', 'open_fee': 2.0, 'close_fee': 2.0},
    "OI": {'name': '菜油', 'multiplier': 10, 'margin_rate': 0.09, 'fee_mode': 'fixed', 'open_fee': 2.0, 'close_fee': 2.0},
    "RM": {'name': '菜粕', 'multiplier': 10, 'margin_rate': 0.09, 'fee_mode': 'fixed', 'open_fee': 1.5, 'close_fee': 1.5},
    "SA": {'name': '纯碱', 'multiplier': 20, 'margin_rate': 0.1, 'fee_mode': 'fixed', 'open_fee': 3.5, 'close_fee': 3.5},
    "SC": {'name': '原油', 'multiplier': 1000, 'margin_rate': 0.1, 'fee_mode': 'fixed', 'open_fee': 20.0, 'close_fee': 20.0},
    "SI": {'name': '工业硅', 'multiplier': 5, 'margin_rate': 0.1, 'fee_mode': 'rate', 'open_fee': 0.0001, 'close_fee': 0.0001},
    "SR": {'name': '白糖', 'multiplier': 10, 'margin_rate': 0.08, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
    "T": {'name': '10年期国债', 'multiplier': 10000, 'margin_rate': 0.02, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
    "TA": {'name': 'PTA', 'multiplier': 5, 'margin_rate': 0.08, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
    "TF": {'name': '5年期国债', 'multiplier': 10000, 'margin_rate': 0.012, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
    "TL": {'name': '30年期国债', 'multiplier': 10000, 'margin_rate': 0.035, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
    "TS": {'name': '2年期国债', 'multiplier': 20000, 'margin_rate': 0.005, 'fee_mode': 'fixed', 'open_fee': 3.0, 'close_fee': 3.0},
}
