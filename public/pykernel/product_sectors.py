"""品种板块映射 —— 跨品种验证用（同板块 = 经济逻辑关联的品种组）

跨品种验证的前提：因子若真有经济含义，应在关联品种上迁移；过拟合
恰好在别的品种上现形。板块按产业链划分，组内按流动性排序
（排前的优先选为验证伙伴）。
"""

from __future__ import annotations

SECTORS: dict[str, list[str]] = {
    # 黑色产业链
    "ferrous": ["rb", "hc", "i", "j", "jm", "sf", "sm"],
    # 有色金属
    "nonferrous": ["cu", "al", "zn", "ni", "pb", "sn", "ss", "ao"],
    # 贵金属
    "precious": ["au", "ag"],
    # 能源
    "energy": ["sc", "fu", "lu", "nr", "pg", "ta", "ma", "eg", "eb", "l", "pp", "v", "sa", "ur", "pf", "ru", "bu", "sp", "br"],
    # 农产品
    "agri": ["m", "y", "a", "p", "oi", "rm", "cf", "cy", "sr", "ap", "cj", "lh", "jd", "fb", "wr", "ri"],
    # 玉米系单列（与油料链相关性较弱）
    "corn": ["c", "cs"],
    # 股指/国债（金融）
    "financial": ["if", "ih", "ic", "im", "t", "tf", "ts", "tl"],
}

_CODE_TO_SECTOR: dict[str, str] = {
    code: sector for sector, codes in SECTORS.items() for code in codes
}


def get_sector(code: str) -> str | None:
    """品种 code（小写）→ 板块名；未映射返回 None"""
    return _CODE_TO_SECTOR.get((code or "").strip().lower())


def get_cross_peers(code: str, k: int = 4) -> list[str]:
    """同板块验证伙伴（按板块内流动性排序取前 k，排除自身）"""
    sector = get_sector(code)
    if not sector:
        return []
    c = (code or "").strip().lower()
    return [p for p in SECTORS[sector] if p != c][: max(0, k)]
