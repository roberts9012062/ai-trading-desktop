"""单因子回测数值对齐:后端原版内核+端点主体 vs 本地 factor_local

流程:后端原版(文件精确挂载)先跑种子化搜索取真实冠军 tokens(确定性),
再分别用后端内核函数(端点主体逐字重演)与本地 run_backtest_factor
对同一份 K 线出报告比对。用法:python scripts/align_factor_bt.py [symbol]
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT.parent / "qihuo" / "backend"
APP = BACKEND / "app"
SVC = APP / "services"
FL = SVC / "factor_lab"
BASE = "https://uusb.eu.org:3051"

SYMBOL = sys.argv[1] if len(sys.argv) > 1 else "rb2610"
SEED = 2026


class Dummy(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {"__call__": lambda *a, **k: None})


def load_real(fullname, path):
    spec = importlib.util.spec_from_file_location(fullname, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[fullname] = mod
    spec.loader.exec_module(mod)


def pkg(fullname, directory):
    m = types.ModuleType(fullname)
    m.__path__ = [str(directory)]
    sys.modules[fullname] = m


def mount_backend():
    pkg("app", APP)
    pkg("app.services", SVC)
    pkg("app.data", APP / "data")
    pkg("app.data.specs", APP / "data" / "specs")
    pkg("app.services.factor_lab", FL)
    pkg("app.services.factor_lab.scoring", FL / "scoring")
    for name in ["app.services.kline_history", "app.services.kline", "app.models", "app.core", "app.core.trading_mode"]:
        sys.modules[name] = Dummy(name)
    load_real("app.data.contracts", APP / "data" / "contracts.py")
    load_real("app.data.specs.product_specs_table", APP / "data" / "specs" / "product_specs_table.py")
    load_real("app.data.specs.product_specs_other", APP / "data" / "specs" / "product_specs_other.py")
    load_real("app.data.specs.product_specs_shfe_dce", APP / "data" / "specs" / "product_specs_shfe_dce.py")
    load_real("app.data.specs.product_specs", APP / "data" / "specs" / "product_specs.py")
    load_real("app.data.product_specs", APP / "data" / "product_specs.py")
    load_real("app.data.product_sectors", APP / "data" / "product_sectors.py")
    load_real("app.services.session_profiles", SVC / "session_profiles.py")
    load_real("app.services.trading_hours", SVC / "trading_hours.py")
    load_real("app.services.factor_lab.token_encoding", FL / "token_encoding.py")
    load_real("app.services.factor_lab.vm", FL / "vm.py")
    load_real("app.services.factor_lab.express", FL / "express.py")
    load_real("app.services.factor_lab.features", FL / "features.py")
    load_real("app.services.factor_lab.ops", FL / "ops.py")
    for f in (FL / "scoring").glob("*.py"):
        load_real(f"app.services.factor_lab.scoring.{f.stem}", f)
    load_real("app.services.factor_lab.search", FL / "search.py")
    # 真实 __init__:提供 execute/is_constant/to_text 等包级转发(子模块已就位)
    load_real("app.services.factor_lab", FL / "__init__.py")


def fetch_bars():
    data = json.loads(urlopen(f"{BASE}/api/market/kline?symbol={SYMBOL}&period=1d&limit=300", timeout=30).read())
    return [{"time": str(b["time"]), "open": float(b["open"]), "high": float(b["high"]),
             "low": float(b["low"]), "close": float(b["close"]), "volume": float(b["volume"])}
            for b in data["bars"]]


def round_value(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, dict):
        return {k: round_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [round_value(x) for x in v]
    if isinstance(v, (int, float)):
        return round(float(v), 4)
    return v


def run_backend(tokens, bars):
    """端点主体逐字重演(基于后端真实内核函数)"""
    import numpy as np

    from app.services.factor_lab import execute
    from app.services.factor_lab.features import feature_matrix
    from app.services.factor_lab.scoring.cost import DEFAULT_SLIPPAGE_TICKS, turnover_cost_rate
    from app.services.factor_lab.scoring.evaluate import (
        evaluate_factor, evaluate_factor_live, next_ret, position_from_factor,
    )
    from app.services.factor_lab.scoring.periods import bars_per_year

    mat = feature_matrix(bars)
    factor = execute(tokens, mat)
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    valid = [c for c in close.tolist() if c > 0]
    recent = valid[-max(60, len(valid) // 4):]
    price = sorted(recent)[len(recent) // 2]
    cost = turnover_cost_rate(SYMBOL, price, DEFAULT_SLIPPAGE_TICKS)
    periods = bars_per_year(bars, "1d")
    metrics = evaluate_factor(factor, close, cost=cost, periods=periods)
    live = evaluate_factor_live(factor, close, cost=cost, periods=periods)
    pos = position_from_factor(factor)
    ret = next_ret(close)
    pnl = pos * ret - np.abs(pos - np.roll(pos, 1)) * cost
    pnl[0] = 0.0
    equity = 100000.0 * (1.0 + np.cumsum(pnl))
    n = len(bars)
    step = max(1, n // 300)
    curve = [{"time": str(bars[i].get("time") or ""), "equity": round(float(equity[i]), 2),
              "position": round(float(pos[i]), 4), "price": round(float(close[i]), 4)}
             for i in range(0, n, step)]
    if (n - 1) % step:
        curve.append({"time": str(bars[-1].get("time") or ""), "equity": round(float(equity[-1]), 2),
                      "position": round(float(pos[-1]), 4), "price": round(float(close[-1]), 4)})
    return {"bars": n, "cost": cost, "metrics": {k: round_value(v) for k, v in metrics.items()},
            "live_metrics": {k: round_value(v) for k, v in live.items()}, "equity_curve": curve}


def run_local(tokens, bars):
    sys.path.insert(0, str(ROOT / "public" / "pykernel"))
    import factor_local

    payload = {"mode": "backtest_factor", "symbol": SYMBOL, "timeframe": "1d",
               "factor_tokens": tokens, "initial_cash": 100000.0, "cost": None,
               "walk_forward_folds": 0}
    return json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))


def diff(a, b, path=""):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}.{k}: 仅本地有")
            elif k not in b:
                out.append(f"{path}.{k}: 仅后端有")
            else:
                out.extend(diff(a[k], b[k], f"{path}.{k}"))
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: 长度 {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            out.extend(diff(x, y, f"{path}[{i}]"))
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(float(a) - float(b)) > 1e-9:
            out.append(f"{path}: {a} != {b}")
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")
    return out


def main():
    bars = fetch_bars()
    mount_backend()
    from app.services.factor_lab.search import SearchConfig, search

    champs = search(bars, "1d", SearchConfig(population=16, generations=6, top_n=5, seed=SEED,
                                             train_ratio=0.7, test_recent_bars=40, walk_forward_folds=3))
    tokens = champs[0].tokens
    print(f"单因子回测对齐:{SYMBOL} 1d | {len(bars)} 根 | 冠军: {champs[0].text[:40]}")

    server = run_backend(tokens, bars)
    local = run_local(tokens, bars)
    issues = []
    for f in ["bars", "cost", "metrics", "live_metrics", "equity_curve"]:
        issues.extend(diff(server.get(f), local.get(f), f))

    if issues:
        print(f"\n!! {len(issues)} 处不一致(前 8 条):")
        for x in issues[:8]:
            print("  ", x)
        sys.exit(1)
    print(f"\n✅ 完全一致:cost/metrics/live_metrics/equity_curve({len(server['equity_curve'])} 点)容差 1e-9")


if __name__ == "__main__":
    main()
