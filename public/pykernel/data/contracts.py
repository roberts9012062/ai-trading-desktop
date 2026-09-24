"""全品种期货合约定义 —— 代码、名称、交易所、AKShare symbol

覆盖国内六大期货交易所的所有主流品种：
上期所 (SHFE)、大商所 (DCE)、郑商所 (CZCE)、
中金所 (CFFEX)、广期所 (GFEX)、能源中心 (INE)

合约月份为当前主力月份（2026-08-20 VVTR 全表迁移基线；后续由 contracts_sync
过半自动换月推进，此表作为 Redis 快照丢失时的兜底基线）。
"""

from typing import Any

# 每个品种定义：symbol(合约代码), code(AKShare品种代码), name(中文名), exchange(交易所)
ALL_CONTRACTS: list[dict[str, str]] = [
    # ===== 上期所 (SHFE) =====
    {"symbol": "rb2701", "code": "RB", "name": "螺纹钢2701", "exchange": "上期所"},
    {"symbol": "hc2701", "code": "HC", "name": "热卷2701", "exchange": "上期所"},
    {"symbol": "cu2610", "code": "CU", "name": "沪铜2610", "exchange": "上期所"},
    {"symbol": "al2610", "code": "AL", "name": "沪铝2610", "exchange": "上期所"},
    {"symbol": "zn2610", "code": "ZN", "name": "沪锌2610", "exchange": "上期所"},
    {"symbol": "pb2610", "code": "PB", "name": "沪铅2610", "exchange": "上期所"},
    {"symbol": "ni2610", "code": "NI", "name": "沪镍2610", "exchange": "上期所"},
    {"symbol": "sn2610", "code": "SN", "name": "沪锡2610", "exchange": "上期所"},
    {"symbol": "au2612", "code": "AU", "name": "沪金2612", "exchange": "上期所"},
    {"symbol": "ag2612", "code": "AG", "name": "沪银2612", "exchange": "上期所"},
    {"symbol": "ss2610", "code": "SS", "name": "不锈钢2610", "exchange": "上期所"},
    {"symbol": "bu2612", "code": "BU", "name": "沥青2612", "exchange": "上期所"},
    {"symbol": "ru2701", "code": "RU", "name": "橡胶2701", "exchange": "上期所"},
    {"symbol": "nr2611", "code": "NR", "name": "20号胶2611", "exchange": "上期所"},
    {"symbol": "sp2701", "code": "SP", "name": "纸浆2701", "exchange": "上期所"},
    {"symbol": "wr2701", "code": "WR", "name": "线材2701", "exchange": "上期所"},

    # ===== 大商所 (DCE) =====
    {"symbol": "i2701", "code": "I", "name": "铁矿石2701", "exchange": "大商所"},
    {"symbol": "j2701", "code": "J", "name": "焦炭2701", "exchange": "大商所"},
    {"symbol": "jm2701", "code": "JM", "name": "焦煤2701", "exchange": "大商所"},
    {"symbol": "m2705", "code": "M", "name": "豆粕2705", "exchange": "大商所"},
    {"symbol": "y2705", "code": "Y", "name": "豆油2705", "exchange": "大商所"},
    {"symbol": "p2705", "code": "P", "name": "棕榈油2705", "exchange": "大商所"},
    {"symbol": "c2611", "code": "C", "name": "玉米2611", "exchange": "大商所"},
    {"symbol": "cs2611", "code": "CS", "name": "淀粉2611", "exchange": "大商所"},
    {"symbol": "a2701", "code": "A", "name": "豆一2701", "exchange": "大商所"},
    {"symbol": "b2611", "code": "B", "name": "豆二2611", "exchange": "大商所"},
    {"symbol": "jd2611", "code": "JD", "name": "鸡蛋2611", "exchange": "大商所"},
    {"symbol": "rr2610", "code": "RR", "name": "粳米2610", "exchange": "大商所"},
    {"symbol": "l2701", "code": "L", "name": "塑料2701", "exchange": "大商所"},
    {"symbol": "v2701", "code": "V", "name": "PVC2701", "exchange": "大商所"},
    {"symbol": "pp2701", "code": "PP", "name": "聚丙烯2701", "exchange": "大商所"},
    {"symbol": "eg2701", "code": "EG", "name": "乙二醇2701", "exchange": "大商所"},
    {"symbol": "eb2611", "code": "EB", "name": "苯乙烯2611", "exchange": "大商所"},
    {"symbol": "pg2611", "code": "PG", "name": "液化气2611", "exchange": "大商所"},
    {"symbol": "fb2611", "code": "FB", "name": "纤维板2611", "exchange": "大商所"},
    {"symbol": "bb2701", "code": "BB", "name": "胶合板2701", "exchange": "大商所"},

    # ===== 郑商所 (CZCE) =====
    {"symbol": "cf2701", "code": "CF", "name": "棉花2701", "exchange": "郑商所"},
    {"symbol": "cy2701", "code": "CY", "name": "棉纱2701", "exchange": "郑商所"},
    {"symbol": "sr2701", "code": "SR", "name": "白糖2701", "exchange": "郑商所"},
    {"symbol": "ta2701", "code": "TA", "name": "PTA2701", "exchange": "郑商所"},
    {"symbol": "ma2701", "code": "MA", "name": "甲醇2701", "exchange": "郑商所"},
    {"symbol": "fg2701", "code": "FG", "name": "玻璃2701", "exchange": "郑商所"},
    {"symbol": "sa2701", "code": "SA", "name": "纯碱2701", "exchange": "郑商所"},
    {"symbol": "ur2701", "code": "UR", "name": "尿素2701", "exchange": "郑商所"},
    {"symbol": "ap2701", "code": "AP", "name": "苹果2701", "exchange": "郑商所"},
    {"symbol": "cj2701", "code": "CJ", "name": "红枣2701", "exchange": "郑商所"},
    {"symbol": "wh2703", "code": "WH", "name": "强麦2703", "exchange": "郑商所"},
    {"symbol": "pm2611", "code": "PM", "name": "普麦2611", "exchange": "郑商所"},
    {"symbol": "ri2707", "code": "RI", "name": "早籼稻2707", "exchange": "郑商所"},
    {"symbol": "rs2611", "code": "RS", "name": "菜籽2611", "exchange": "郑商所"},
    {"symbol": "rm2701", "code": "RM", "name": "菜粕2701", "exchange": "郑商所"},
    {"symbol": "oi2701", "code": "OI", "name": "菜油2701", "exchange": "郑商所"},
    {"symbol": "pf2611", "code": "PF", "name": "短纤2611", "exchange": "郑商所"},
    {"symbol": "sh2611", "code": "SH", "name": "烧碱2611", "exchange": "郑商所"},

    # ===== 大商所 (DCE) =====
    {"symbol": "lh2701", "code": "LH", "name": "生猪2701", "exchange": "大商所"},

    # ===== 中金所 (CFFEX) =====
    {"symbol": "if2609", "code": "IF", "name": "沪深300股指2609", "exchange": "中金所"},
    {"symbol": "ic2609", "code": "IC", "name": "中证500股指2609", "exchange": "中金所"},
    {"symbol": "im2609", "code": "IM", "name": "中证1000股指2609", "exchange": "中金所"},
    {"symbol": "ih2609", "code": "IH", "name": "上证50股指2609", "exchange": "中金所"},
    {"symbol": "tf2612", "code": "TF", "name": "5年期国债2612", "exchange": "中金所"},
    {"symbol": "t2612", "code": "T", "name": "10年期国债2612", "exchange": "中金所"},
    {"symbol": "ts2612", "code": "TS", "name": "2年期国债2612", "exchange": "中金所"},
    {"symbol": "tl2612", "code": "TL", "name": "30年期国债2612", "exchange": "中金所"},

    # ===== 广期所 (GFEX) =====
    {"symbol": "si2611", "code": "SI", "name": "工业硅2611", "exchange": "广期所"},
    {"symbol": "lc2701", "code": "LC", "name": "碳酸锂2701", "exchange": "广期所"},

    # ===== 能源中心 (INE) =====
    {"symbol": "sc2611", "code": "SC", "name": "原油2611", "exchange": "能源中心"},
    {"symbol": "lu2611", "code": "LU", "name": "低硫燃油2611", "exchange": "能源中心"},
    {"symbol": "bc2610", "code": "BC", "name": "国际铜2610", "exchange": "能源中心"},
    {"symbol": "ec2610", "code": "EC", "name": "集运指数2610", "exchange": "能源中心"},
]

# 模拟基准价格（AKShare 不可用时使用）
MOCK_BASE_PRICES: dict[str, float] = {
    # 上期所
    "rb2610": 3150.0, "hc2610": 3380.0, "cu2607": 78500.0,
    "al2607": 20300.0, "zn2607": 22800.0, "pb2607": 16800.0,
    "ni2607": 124500.0, "sn2607": 262000.0, "au2612": 680.0,
    "ag2612": 8350.0, "ss2609": 13800.0, "bu2612": 3500.0,
    "ru2609": 14500.0, "nr2609": 11800.0, "sp2609": 5600.0,
    "wr2610": 3300.0,
    # 大商所
    "i2609": 760.0, "j2609": 2280.0, "jm2609": 1280.0,
    "m2609": 3100.0, "y2609": 7900.0, "p2609": 8200.0,
    "c2609": 2450.0, "cs2609": 2900.0, "a2609": 4200.0,
    "b2609": 3800.0, "jd2609": 3800.0, "rr2609": 3600.0,
    "l2609": 7700.0, "v2609": 6500.0, "pp2609": 7200.0,
    "eg2609": 4400.0, "eb2609": 8200.0, "pg2609": 4700.0,
    "fb2609": 1300.0, "bb2609": 120.0,
    # 郑商所
    "cf2609": 13800.0, "cy2609": 20500.0, "sr2609": 5800.0,
    "ta2609": 4800.0, "ma2609": 2300.0, "fg2609": 1300.0,
    "sa2609": 1600.0, "ur2609": 1900.0, "ap2610": 8650.0,
    "cj2609": 10500.0, "wh2611": 2700.0, "pm2611": 2500.0,
    "ri2609": 2600.0, "rs2609": 5200.0, "rm2609": 2300.0,
    "oi2609": 8800.0, "pf2609": 6800.0, "sh2609": 2800.0,
    "lh2609": 14500.0,
    # 中金所
    "if2606": 3850.0, "ic2606": 5800.0, "im2606": 6200.0,
    "ih2606": 2650.0, "tf2606": 101.5, "t2606": 99.0,
    "ts2606": 100.8, "tl2606": 95.0,
    # 广期所
    "si2609": 11500.0, "lc2609": 85000.0,
    # 能源中心
    "sc2607": 520.0, "lu2607": 3200.0, "bc2607": 72000.0,
    "ec2606": 1800.0,
}

def get_mock_base_price(symbol: str) -> float:
    """获取合约的模拟基准价格，未定义的品种返回默认值 5000"""
    return MOCK_BASE_PRICES.get(symbol, 5000.0)


# 各品种最小变动价位（tick size）
TICK_SIZES: dict[str, float] = {
    # 上期所
    "RB": 1, "HC": 1, "CU": 10, "AL": 5, "ZN": 5, "PB": 5,
    "NI": 10, "SN": 10, "AU": 0.02, "AG": 1, "SS": 5,
    "BU": 2, "RU": 5, "NR": 5, "SP": 2, "WR": 1,
    # 大商所
    "I": 0.5, "J": 0.5, "JM": 0.5, "M": 1, "Y": 2, "P": 2,
    "C": 1, "CS": 1, "A": 1, "B": 1, "JD": 1, "RR": 1,
    "L": 1, "V": 1, "PP": 1, "EG": 1, "EB": 1, "PG": 1,
    "FB": 0.5, "BB": 0.05,
    # 郑商所
    "CF": 5, "CY": 5, "SR": 1, "TA": 2, "MA": 1, "FG": 1,
    "SA": 1, "UR": 1, "AP": 1, "CJ": 5, "WH": 1, "PM": 1,
    "RI": 1, "RS": 1, "RM": 1, "OI": 1, "PF": 2, "SH": 1, "LH": 5,
    # 中金所
    "IF": 0.2, "IC": 0.2, "IM": 0.2, "IH": 0.2,
    "TF": 0.005, "T": 0.005, "TS": 0.005, "TL": 0.01,
    # 广期所
    "SI": 5, "LC": 50,
    # 能源中心
    "SC": 0.1, "LU": 1, "BC": 10, "EC": 0.1,
}

DEFAULT_TICK_SIZE = 1.0

# symbol → code 查找表（rebuild_lookups 构建/重建）
_SYMBOL_TO_CODE: dict[str, str] = {}
# 字母前缀 → code 兜底映射（用于连续合约符号 rb888 / 纯前缀 rb）
_LETTER_PREFIX_TO_CODE: dict[str, str] = {}
# code → 主力合约 symbol（每个 code 在表中的第一个 symbol，如 RB → rb2610）
_CODE_TO_MASTER_SYMBOL: dict[str, str] = {}
# code → 中文品种名（去掉月份数字，如 螺纹钢2610 → 螺纹钢）
_CODE_TO_PRODUCT_NAME: dict[str, str] = {}
# symbol → 中文全名（含月份）
_SYMBOL_TO_NAME: dict[str, str] = {}


def rebuild_lookups() -> None:
    """从 ALL_CONTRACTS 当前内容重建全部派生查找表

    apply_active_contracts 原地更新合约表后必须调用，否则
    get_code_for_symbol / get_contract_name 等仍读旧表。
    """
    global _SYMBOL_TO_CODE, _LETTER_PREFIX_TO_CODE, _CODE_TO_MASTER_SYMBOL
    global _CODE_TO_PRODUCT_NAME, _SYMBOL_TO_NAME

    _SYMBOL_TO_CODE = {c["symbol"]: c["code"] for c in ALL_CONTRACTS}

    _LETTER_PREFIX_TO_CODE = {}
    for c in ALL_CONTRACTS:
        letters = "".join(
            ch for ch in str(c.get("symbol") or "") if ch.isalpha()
        ).lower()
        if letters and letters not in _LETTER_PREFIX_TO_CODE:
            _LETTER_PREFIX_TO_CODE[letters] = c["code"]

    _CODE_TO_MASTER_SYMBOL = {}
    for c in ALL_CONTRACTS:
        code_u = str(c.get("code") or "").upper()
        sym = str(c.get("symbol") or "")
        if code_u and sym and code_u not in _CODE_TO_MASTER_SYMBOL:
            _CODE_TO_MASTER_SYMBOL[code_u] = sym

    _CODE_TO_PRODUCT_NAME = {}
    for c in ALL_CONTRACTS:
        code = str(c.get("code") or "").upper()
        if not code or code in _CODE_TO_PRODUCT_NAME:
            continue
        raw_name = str(c.get("name") or "")
        product = "".join(ch for ch in raw_name if not ch.isdigit()).strip()
        _CODE_TO_PRODUCT_NAME[code] = product or code

    _SYMBOL_TO_NAME = {
        str(c["symbol"]).lower(): str(c["name"]) for c in ALL_CONTRACTS
    }


def apply_active_contracts(entries: list[dict[str, str]]) -> int:
    """用 VVTR 当前主力清单原地更新合约表（每品种一个主力合约）

    entries: [{symbol, code, name?, exchange?}]，symbol 为 VVTR realSymbol
    返回的当前真实主力（如 pp2701）。合并规则：
    - 静态表已有品种：保留人工维护的名称/交易所，仅替换月份合约；
    - VVTR 独有新品种：按 entries 追加；
    - VVTR 未返回的品种：保留静态条目兜底。
    返回变更条数；原地更新后自动 rebuild_lookups()。
    """
    if not entries:
        return 0
    by_code: dict[str, dict[str, str]] = {}
    for e in entries:
        code = str(e.get("code") or "").strip().upper()
        sym = str(e.get("symbol") or "").strip().lower()
        if code and sym and code not in by_code:
            by_code[code] = {**e, "code": code, "symbol": sym}

    changed = 0
    new_list: list[dict[str, str]] = []
    seen_codes: set[str] = set()
    for c in ALL_CONTRACTS:
        code = str(c.get("code") or "").strip().upper()
        item = dict(c)
        target = by_code.get(code)
        if target and target["symbol"] != str(c.get("symbol") or "").lower():
            product = _CODE_TO_PRODUCT_NAME.get(code) or ""
            digits = "".join(ch for ch in target["symbol"] if ch.isdigit())
            item["symbol"] = target["symbol"]
            if product and digits:
                item["name"] = f"{product}{digits}"
            changed += 1
        new_list.append(item)
        if code:
            seen_codes.add(code)

    # VVTR 独有新品种（静态表未收录）
    for code, target in by_code.items():
        if code in seen_codes:
            continue
        new_list.append(
            {
                "symbol": target["symbol"],
                "code": code,
                "name": str(target.get("name") or code),
                "exchange": str(target.get("exchange") or ""),
            }
        )
        changed += 1

    if not changed:
        return 0
    ALL_CONTRACTS[:] = new_list
    rebuild_lookups()
    return changed


rebuild_lookups()


def get_code_for_symbol(symbol: str) -> str:
    """根据合约代码获取品种代码，未找到返回空字符串。

    支持三种形式：
    - 具体月份合约：rb2610 → RB（精确查 _SYMBOL_TO_CODE）
    - 连续主力合约：rb888 → RB（提取字母前缀 rb 兜底）
    - 纯品种前缀：rb → RB（同上）
    """
    s = str(symbol or "").strip()
    # 1. 精确匹配（小写优先，兼容原行为）
    hit = _SYMBOL_TO_CODE.get(s.lower(), "") or _SYMBOL_TO_CODE.get(s, "")
    if hit:
        return hit
    # 2. 字母前缀兜底：rb888 / rb → rb → RB
    letters = "".join(ch for ch in s if ch.isalpha()).lower()
    return _LETTER_PREFIX_TO_CODE.get(letters, "")


def get_master_symbol_for_code(symbol: str) -> str:
    """把任意品种形式（rb / rb888 / rb2610 / RB）规整为主力合约符号（如 rb2610）。

    用于超级因子挖掘等用品种 code 的场景，规整后与因子实验室/AI交易/回测的
    symbol 口径统一（它们都需要具体月份合约符号 rb2610，不认纯品种 rb）。
    规整失败（找不到 code）时原样返回，不抛异常。
    """
    code = get_code_for_symbol(symbol)
    if code:
        master = _CODE_TO_MASTER_SYMBOL.get(code)
        if master:
            return master
    return str(symbol or "")


def get_product_name(code: str) -> str:
    """品种代码 → 中文名（无月份），如 RB → 螺纹钢。"""
    return _CODE_TO_PRODUCT_NAME.get(code.upper(), code.upper())


def get_contract_name(symbol: str) -> str:
    """合约代码 → 中文全名，如 rb2610 → 螺纹钢2610；未知则尽力推断。"""
    key = symbol.strip().lower()
    if key in _SYMBOL_TO_NAME:
        return _SYMBOL_TO_NAME[key]
    # 动态主力月份：用品种中文名 + 数字后缀
    code = "".join(ch for ch in key if ch.isalpha()).upper()
    digits = "".join(ch for ch in key if ch.isdigit())
    product = get_product_name(code) if code else key
    return f"{product}{digits}" if digits else product


def get_tick_size(code: str) -> float:
    """获取品种的最小变动价位，未定义的品种返回默认值 1.0"""
    return TICK_SIZES.get(code.upper(), DEFAULT_TICK_SIZE)


def get_decimal_places(code: str) -> int:
    """根据品种 tick size 推算价格应显示的小数位数

    tick >= 1 的品种（如螺纹钢 tick=1）显示整数，
    tick < 1 的品种按 tick 精度显示对应小数位（如 AU tick=0.02 → 2 位）。
    """
    tick = get_tick_size(code)
    if tick >= 1:
        return 0
    tick_str = f"{tick:.10f}".rstrip("0").split(".")
    return len(tick_str[1]) if len(tick_str) > 1 else 0


def round_by_tick(price: float, code: str) -> float:
    """按品种最小变动价位取整价格"""
    tick = get_tick_size(code)
    return round(round(price / tick) * tick, 10)
