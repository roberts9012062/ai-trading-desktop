"""因子内核数值对齐回归:后端原版 factor_lab.search vs 本地 factor_local(种子化)

装载策略与 align_backtest.py 相同:后端模块按文件精确挂载(不执行 __init__ 链),
重依赖桩化;两边用同一 seed 的 SearchConfig 跑同一份真实 K 线,
GP 进化完全确定 → 冠军列表应逐项一致。

用法:python scripts/align_factor.py [symbol] [period]
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
PERIOD = sys.argv[2] if len(sys.argv) > 2 else "1d"
SEED = 2026
CFG = {"population": 16, "generations": 6, "top_n": 5, "seed": SEED,
       "train_ratio": 0.7, "test_recent_bars": 40, "walk_forward_folds": 3}


def fetch_bars() -> list[dict]:
    url = f"{BASE}/api/market/kline?symbol={SYMBOL}&period={PERIOD}&limit=300"
    data = json.loads(urlopen(url, timeout=30).read())
    bars = [
        {"time": str(b["time"]), "open": float(b["open"]), "high": float(b["high"]),
         "low": float(b["low"]), "close": float(b["close"]), "volume": float(b["volume"])}
        for b in data.get("bars", [])
    ]
    if not bars:
        raise RuntimeError("无数据")
    return bars


class Dummy(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {"__call__": lambda *a, **k: None})


def load_real(fullname: str, path: Path) -> None:
    spec = importlib.util.spec_from_file_location(fullname, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[fullname] = mod
    spec.loader.exec_module(mod)


def pkg(fullname: str, directory: Path) -> None:
    m = types.ModuleType(fullname)
    m.__path__ = [str(directory)]
    sys.modules[fullname] = m


def stub(fullname: str) -> None:
    sys.modules[fullname] = Dummy(fullname)


def run_backend(bars: list[dict]) -> list[dict]:
    pkg("app", APP)
    pkg("app.services", SVC)
    pkg("app.data", APP / "data")
    pkg("app.data.specs", APP / "data" / "specs")
    pkg("app.services.factor_lab", FL)
    pkg("app.services.factor_lab.scoring", FL / "scoring")
    for name in [
        "app.services.kline_history", "app.services.kline", "app.models",
        "app.core", "app.core.trading_mode", "app.services.trading_mode",
    ]:
        stub(name)
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

    from app.services.factor_lab.search import SearchConfig, search

    champs = search(bars, PERIOD, SearchConfig(**CFG))
    return [{"tokens": c.tokens, "text": c.text, "metrics": c.metrics, "composite": c.composite} for c in champs]


def run_local(bars: list[dict]) -> list[dict]:
    sys.path.insert(0, str(ROOT / "public" / "pykernel"))
    import factor_local

    payload = {"timeframe": PERIOD, **CFG}
    # run() 统一负责 JSON 解析(run_search 期望已解析的 dict/list)
    return json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))


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
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(float(a) - float(b)) > 1e-9:
            out.append(f"{path}: {a} != {b}")
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")
    return out


def main() -> None:
    bars = fetch_bars()
    print(f"因子对齐:{SYMBOL} {PERIOD} | {len(bars)} 根 | seed={SEED} | cfg={CFG}")

    server = run_backend(bars)
    local = run_local(bars)
    print(f"后端冠军 {len(server)} 个 | 本地冠军 {len(local)} 个")
    for c in (server or [{}])[:3]:
        print(f"  [后端] composite={c.get('composite'):.4f} {str(c.get('text'))[:50]}")
    for c in (local or [{}])[:3]:
        print(f"  [本地] composite={c.get('composite'):.4f} {str(c.get('text'))[:50]}")

    issues = diff(server, local, "champions")
    if issues:
        print(f"\n!! {len(issues)} 处不一致(前 10 条):")
        for x in issues[:10]:
            print("  ", x)
        sys.exit(1)
    print(f"\n✅ 完全一致:冠军列表(tokens/text/metrics/composite)逐项相等(容差 1e-9)")


if __name__ == "__main__":
    main()
