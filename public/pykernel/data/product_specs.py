"""品种规格入口 —— 加密货币(USDT 永续) + 期货(转发至 specs 子包)

加密货币口径(对齐服务端 app/data/specs/product_specs.py):
- multiplier = 1(数量单位即基础币,非「张/手」)
- 手续费 taker 0.05% 开平(费率模式)
- tick_size 按币种查 CRYPTO_TICKS(缺省 0.01)

符号归一:各所原生写法(ADAUSDT/ADA-USDT/ADA_USDT/ADA/USDT/
ADA-USDT-SWAP/ADA/USDT:USDT)统一为规范小写(adausdt)——加密分支
先于期货表判定,任何 usdt 结尾的符号都不会回落到期货默认规格。
"""

from data.specs_product_specs import (
    extract_product_code,
    get_product_spec as _get_futures_spec,
    list_all_product_specs,
)

__all__ = [
    "extract_product_code",
    "get_product_spec",
    "list_all_product_specs",
    "normalize_crypto_symbol",
    "is_crypto_symbol",
    "CRYPTO_TICKS",
    "CRYPTO_SPEC",
]

# 加密货币最小变动价位(对齐服务端 app/data/contracts.py TICK_SIZES)
CRYPTO_TICKS: dict[str, float] = {
    "BTC": 0.1, "ETH": 0.01, "SOL": 0.01, "BNB": 0.01,
    "XRP": 0.0001, "DOGE": 0.00001, "ADA": 0.0001, "AVAX": 0.001,
    "LINK": 0.001, "TON": 0.001, "DOT": 0.001, "ATOM": 0.001,
    "NEAR": 0.001, "APT": 0.001, "SUI": 0.0001, "SEI": 0.0001,
    "TIA": 0.001, "ICP": 0.01, "ETC": 0.01, "LTC": 0.01,
    "BCH": 0.01, "XLM": 0.0001, "VET": 0.00001, "HBAR": 0.0001,
    "ARB": 0.0001, "OP": 0.001, "POL": 0.0001, "STRK": 0.0001,
    "UNI": 0.001, "AAVE": 0.01, "LDO": 0.001, "INJ": 0.001,
    "ENA": 0.0001, "DYDX": 0.001, "RUNE": 0.001, "SHIB": 0.00000001,
    "PEPE": 0.00000001, "WIF": 0.0001, "FLOKI": 0.0000001, "BONK": 0.0000001,
    "ORDI": 0.01, "FET": 0.001, "RENDER": 0.001, "TAO": 0.01,
    "GRT": 0.0001, "AR": 0.001, "FIL": 0.001, "TRX": 0.00001,
    "EGLD": 0.01, "ALGO": 0.0001,
}

DEFAULT_CRYPTO_TICK = 0.01

# 加密货币默认规格(USDT 本位永续)
CRYPTO_SPEC: dict = {
    "code": "CRYPTO",
    "name": "USDT 永续",
    "multiplier": 1,
    "margin_rate": 0.05,
    "fee_mode": "rate",
    "open_fee": 0.0005,
    "close_fee": 0.0005,
    "tick_size": DEFAULT_CRYPTO_TICK,
    "crypto": True,
}


def normalize_crypto_symbol(symbol_or_code: str) -> str | None:
    """加密符号归一 → 规范小写(adausdt);非加密形态返回 None。

    兼容写法:adausdt / ADAUSDT / ADA-USDT / ADA_USDT / ADA/USDT /
    ADA-USDT-SWAP(OKX 永续) / ADA/USDT:USDT(Binance 永续)。
    """
    s = str(symbol_or_code or "").strip().upper()
    if not s:
        return None
    if ":" in s:  # Binance 永续 "BASE/USDT:USDT" → 取冒号前现货写法
        s = s.split(":", 1)[0]
    if s.endswith("-SWAP"):  # OKX 永续后缀
        s = s[: -len("-SWAP")]
    alnum = "".join(ch for ch in s if ch.isalnum())
    if alnum.endswith("USDT") and alnum != "USDT":
        return alnum.lower()
    return None


def is_crypto_symbol(symbol_or_code: str) -> bool:
    """USDT 永续形态判定(未知币也算——规格是否存在由 CRYPTO_TICKS 另判)"""
    return normalize_crypto_symbol(symbol_or_code) is not None


def get_product_spec(symbol_or_code: str) -> dict:
    """获取品种规格:加密符号走 CRYPTO_SPEC(按币 tick 覆盖),其余期货原逻辑"""
    norm = normalize_crypto_symbol(symbol_or_code)
    if norm:
        coin = norm[: -len("usdt")].upper()
        result = dict(CRYPTO_SPEC)
        result["code"] = coin
        result["tick_size"] = CRYPTO_TICKS.get(coin, DEFAULT_CRYPTO_TICK)
        return result
    return _get_futures_spec(symbol_or_code)
