"""回测内核数值对齐回归:后端原版 runner vs 本地 runner_local(同进程、同数据、同解释器)

装载策略:后端模块按文件精确挂载到 app.* 命名空间(不执行任何 __init__ 链),
重依赖(kline 服务/models/factor_lab 等)用通配桩模块代替;数据加载函数
monkeypatch 为同一份 bars 注入。量化策略下两版核心循环逐字同源,浮点应完全一致。

用法:python scripts/align_backtest.py [symbol] [period] [strategy]
K 线从公网 API 拉取(无需登录)。
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
import uuid
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT.parent / "qihuo" / "backend"
APP = BACKEND / "app"
SVC = APP / "services"
BASE = "https://uusb.eu.org:3051"

SYMBOL = sys.argv[1] if len(sys.argv) > 1 else "rb2610"
PERIOD = sys.argv[2] if len(sys.argv) > 2 else "1d"
STRATEGY = sys.argv[3] if len(sys.argv) > 3 else "ma_cross"
STRATEGY_PARAMS = (
    {"fast": 5, "slow": 20} if STRATEGY == "ma_cross"
    else {"window": 20} if STRATEGY == "n_breakout"
    else {}
)


def fetch_bars() -> list[dict]:
    url = f"{BASE}/api/market/kline?symbol={SYMBOL}&period={PERIOD}&limit=400"
    data = json.loads(urlopen(url, timeout=30).read())
    bars = [
        {"time": str(b["time"]), "open": float(b["open"]), "high": float(b["high"]),
         "low": float(b["low"]), "close": float(b["close"]), "volume": float(b["volume"])}
        for b in data.get("bars", [])
    ]
    if not bars:
        raise RuntimeError(f"{SYMBOL} {PERIOD} 无数据")
    return bars


def make_payload(bars: list[dict]) -> dict:
    return {
        "symbol": SYMBOL, "timeframe": PERIOD,
        "start_date": str(bars[0]["time"])[:10], "end_date": str(bars[-1]["time"])[:10],
        "strategy_type": STRATEGY, "strategy_params": STRATEGY_PARAMS,
        "side_mode": "both", "fixed_qty": 1, "initial_cash": 100000.0,
        "multi_segment": False,
    }


class Dummy(types.ModuleType):
    """通配桩:任何属性都返回可调用占位,满足模块级导入即可"""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {"__call__": lambda *a, **k: None})


def load_real(fullname: str, path: Path) -> None:
    spec = importlib.util.spec_from_file_location(fullname, str(path))
    mod = importlib.util.module_from_spec(spec)
    mod.__path__ = [str(path.parent)] if path.name == "__init__.py" else getattr(mod, "__path__", [])
    sys.modules[fullname] = mod
    spec.loader.exec_module(mod)


def pkg(fullname: str, directory: Path) -> None:
    m = types.ModuleType(fullname)
    m.__path__ = [str(directory)]
    sys.modules[fullname] = m


def stub(fullname: str) -> None:
    sys.modules[fullname] = Dummy(fullname)


def load_backend_runner():
    pkg("app", APP)
    pkg("app.services", SVC)
    pkg("app.data", APP / "data")
    pkg("app.data.specs", APP / "data" / "specs")
    pkg("app.services.ai", SVC / "ai")
    pkg("app.services.ai.tools", SVC / "ai" / "tools")
    pkg("app.services.ai_trading", SVC / "ai_trading")
    pkg("app.services.ai_trading.strategies", SVC / "ai_trading" / "strategies")
    pkg("app.services.ai_trading.core", SVC / "ai_trading" / "core")
    pkg("app.services.paper", SVC / "paper")
    pkg("app.services.backtest", SVC / "backtest")

    # 重依赖桩(kline 服务/models/factor_llm/账号服务/交易日模式)
    for name in [
        "app.services.kline", "app.services.paper.account_svc",
        "app.models", "app.models.ai_trading", "app.models.ai_trading.task",
        "app.models.paper", "app.models.paper.settings",
        "app.services.factor_lab", "app.services.factor_lab.features",
        "app.core", "app.core.trading_mode",
    ]:
        stub(name)

    # 真实文件按全名装载(叶子先行)
    load_real("app.data.contracts", APP / "data" / "contracts.py")
    load_real("app.data.specs.product_specs_table", APP / "data" / "specs" / "product_specs_table.py")
    load_real("app.data.specs.product_specs_other", APP / "data" / "specs" / "product_specs_other.py")
    load_real("app.data.specs.product_specs_shfe_dce", APP / "data" / "specs" / "product_specs_shfe_dce.py")
    load_real("app.data.specs.product_specs", APP / "data" / "specs" / "product_specs.py")
    load_real("app.data.product_specs", APP / "data" / "product_specs.py")
    load_real("app.services.ai.tools.calc", SVC / "ai" / "tools" / "calc.py")
    load_real("app.services.signal_pivot", SVC / "signal_pivot.py")
    load_real("app.services.backtest.account", SVC / "backtest" / "account.py")
    load_real("app.services.backtest.metrics", SVC / "backtest" / "metrics.py")
    load_real("app.services.ai_trading.strategies", SVC / "ai_trading" / "strategies" / "__init__.py")
    for f in (SVC / "ai_trading" / "strategies").glob("*.py"):
        if f.name != "__init__.py":
            load_real(f"app.services.ai_trading.strategies.{f.stem}", f)
    load_real("app.services.backtest.signals", SVC / "backtest" / "signals.py")
    load_real("app.services.backtest.data", SVC / "backtest" / "data.py")
    load_real("app.services.ai_trading.core.capital", SVC / "ai_trading" / "core" / "capital.py")
    load_real("app.services.paper.specs", SVC / "paper" / "specs.py")
    load_real("app.services.backtest.runner", SVC / "backtest" / "runner.py")
    return sys.modules["app.services.backtest.runner"]


def run_backend(payload: dict, bars: list[dict]) -> dict:
    R = load_backend_runner()

    async def fake_load(redis_conn, session, symbol, timeframe, s, e):
        return bars

    async def fake_ai(*a, **k):
        raise RuntimeError("AI 不可达")

    R.load_backtest_bars = fake_load
    R._ai_signal = fake_ai
    return asyncio.run(
        R.run_backtest(session=None, redis_conn=None, user_id=uuid.uuid4(), payload=payload)
    )


def run_local(payload: dict, bars: list[dict]) -> dict:
    sys.path.insert(0, str(ROOT / "public" / "pykernel"))
    import runner_local

    return runner_local.run_backtest_local(payload, bars)


def diff(a, b, path="") -> list[str]:
    out: list[str] = []
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
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        if abs(float(a) - float(b)) > 1e-9:
            out.append(f"{path}: {a} != {b}")
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")
    return out


def main() -> None:
    bars = fetch_bars()
    payload = make_payload(bars)
    print(f"对齐:{SYMBOL} {PERIOD} {STRATEGY} | {len(bars)} 根 | {payload['start_date']}~{payload['end_date']}")

    server = run_backend(payload, bars)
    local = run_local(payload, bars)
    print(f"后端:{str(server.get('message'))[:70]}")
    print(f"本地:{str(local.get('message'))[:70]}")

    issues: list[str] = []
    if server.get("status") != local.get("status"):
        issues.append(f"status: {server.get('status')} != {local.get('status')}")
    for f in ["metrics", "equity_curve", "trades", "decisions", "bars"]:
        issues.extend(diff(server.get(f), local.get(f), f))

    if issues:
        print(f"\n!! {len(issues)} 处不一致(前 10 条):")
        for x in issues[:10]:
            print("  ", x)
        sys.exit(1)
    print(f"\n✅ 完全一致:metrics / equity_curve({len(server.get('equity_curve') or [])} 点) / "
          f"trades({len(server.get('trades') or [])} 笔) / decisions / bars(容差 1e-9)")


if __name__ == "__main__":
    main()
