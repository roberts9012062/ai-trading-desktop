"""导出挖掘基准评测用 K 线(bench-mining.py 的数据源)

从 FuturesData 项目的 tickdata 库拉取各品种指数合约(xx8888,加权指数,
无换月跳空)日线,写入 scripts/.bench-data/<品种>_1d.json(已 gitignore)。
需用 FuturesData 的虚拟环境运行(依赖 asyncpg/python-dotenv 与其 .env):

    ../FuturesData/.venv/Scripts/python.exe scripts/export-bench-bars.py
    ../FuturesData/.venv/Scripts/python.exe scripts/export-bench-bars.py --symbols rb,cu --period 60
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "scripts" / ".bench-data"
DEFAULT_SYMBOLS = "rb,i,hc,cu,al,zn,au,ag,m,y,p,ta,ma,sr,cf,c"
PERIOD_TAG = {1440: "1d", 60: "1h", 30: "30m", 15: "15m"}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--futures-data", default=str(ROOT.parent / "FuturesData"))
    ap.add_argument("--symbols", default=DEFAULT_SYMBOLS)
    ap.add_argument("--period", type=int, default=1440, help="分钟数:1440=日线")
    args = ap.parse_args()

    from dotenv import load_dotenv
    import asyncpg

    load_dotenv(Path(args.futures_data) / ".env")
    conn = await asyncpg.connect(
        host=os.environ["PG_HOST"],
        port=int(os.environ["PG_PORT"]),
        user=os.environ["PG_USER"],
        password=os.environ["PG_PASSWORD"],
        database=os.environ["PG_DATABASE"],
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tag = PERIOD_TAG.get(args.period, f"{args.period}m")
    try:
        for sym in [s.strip().lower() for s in args.symbols.split(",") if s.strip()]:
            rows = await conn.fetch(
                "SELECT ts, open, high, low, close, volume, position FROM kline "
                "WHERE period = $1 AND instrument = $2 ORDER BY ts",
                args.period,
                f"{sym}8888",
            )
            bars = [
                {
                    "time": r["ts"].isoformat(),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume": float(r["volume"] or 0),
                    "open_interest": float(r["position"] or 0),
                }
                for r in rows
                if r["close"] and float(r["close"]) > 0
            ]
            path = OUT_DIR / f"{sym}_{tag}.json"
            path.write_text(json.dumps(bars), encoding="utf-8")
            span = f"{bars[0]['time'][:10]} ~ {bars[-1]['time'][:10]}" if bars else "-"
            print(f"{sym:>3} {tag}: {len(bars):>5} 根 {span} → {path.name}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
