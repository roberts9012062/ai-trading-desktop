"""验证套件取数:Binance Vision UM 永续月度归档 K 线(与 G2 取数同源)。

产物:.local-data/factor-verify/{symbol}-{tf}.bars.json —— 与 G2 冻结数据
同 shape(time/open/high/low/close/volume/quote_volume/trade_count/
taker_buy_volume/taker_buy_quote_volume),供 factor-verify-run.py 消费。
REST(fapi)在本机被 451 屏蔽,归档通道此前取 G2 数据已验证可达。
"""
import argparse
import csv
import hashlib
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".local-data" / "factor-verify"
CACHE = ROOT / ".local-data" / "factor-verify-archives"
BASE = "https://data.binance.vision/data/futures/um/monthly/klines"

# 每周期取多少个月(对齐 App mid 档默认区间;1m/5m/15m 取较短迭代区间)
MONTHS = {"1d": 60, "60m": 24, "30m": 24, "15m": 12, "5m": 12, "1m": 4}
# 归档目录的区间命名:60m 在 Vision 归档叫 1h
ARCHIVE_TF = {"1d": "1d", "60m": "1h", "30m": "30m", "15m": "15m", "5m": "5m", "1m": "1m"}


def month_range(n: int) -> list[str]:
    """截至上个月的最近 n 个完整月份(当月归档未发布)。"""
    now = datetime.now(timezone.utc)
    y, m = now.year, now.month - 1
    if m == 0:
        y, m = y - 1, 12
    out = []
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def download(url: str) -> bytes:
    for attempt in range(4):
        try:
            with urlopen(url, timeout=120) as response:
                return response.read()
        except Exception:  # noqa: BLE001 - 重试后仍失败再抛
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def fetch_month(symbol: str, tf: str, month: str) -> list[dict]:
    interval = ARCHIVE_TF[tf]
    name = f"{symbol}-{interval}-{month}"
    url = f"{BASE}/{symbol}/{interval}/{name}.zip"
    target, checksum = CACHE / f"{name}.zip", CACHE / f"{name}.CHECKSUM"
    if not target.exists():
        target.write_bytes(download(url))
    if not checksum.exists():
        checksum.write_bytes(download(url + ".CHECKSUM"))
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != checksum.read_text().split()[0]:
        raise ValueError(f"Archive hash mismatch: {url}")
    with ZipFile(io.BytesIO(target.read_bytes())) as z:
        text = z.read(z.namelist()[0]).decode("utf-8-sig")
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if not row or not row[0].isdigit():
            continue
        stamp = int(row[0])
        stamp = stamp // 1000 if stamp > 10**14 else stamp
        rows.append({
            "time": datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat(),
            "open_time": stamp,
            "open": float(row[1]), "high": float(row[2]),
            "low": float(row[3]), "close": float(row[4]),
            "volume": float(row[5]), "quote_volume": float(row[7]),
            "trade_count": float(row[8]),
            "taker_buy_volume": float(row[9]), "taker_buy_quote_volume": float(row[10]),
        })
    return rows


def fetch_symbol_tf(symbol: str, tf: str) -> int:
    target = OUT / f"{symbol}-{tf}.bars.json"
    if target.exists():
        print(f"skip {target.name}", flush=True)
        return 0
    months = month_range(MONTHS[tf])
    jobs = [(symbol, tf, m) for m in months]
    all_rows = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for rows in pool.map(lambda j: fetch_month(*j), jobs):
            all_rows.extend(rows)
            print(f"  {symbol} {tf}: +{len(rows)} rows", flush=True)
    seen, uniq = set(), []
    for row in all_rows:
        if row["open_time"] not in seen:
            seen.add(row["open_time"])
            uniq.append(row)
    uniq.sort(key=lambda r: r["open_time"])
    target.write_text(json.dumps(uniq, separators=(",", ":")), encoding="utf-8")
    print(f"{symbol} {tf}: {len(uniq)} bars -> {target.name}", flush=True)
    return len(uniq)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbols", nargs="+", default=["BTCUSDT", "ETHUSDT"])
    parser.add_argument("--timeframes", nargs="+", default=list(MONTHS))
    parser.add_argument("--extra-symbols-30m-60m", nargs="*", default=["ADAUSDT", "LTCUSDT"])
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    for symbol in args.symbols:
        for tf in args.timeframes:
            fetch_symbol_tf(symbol, tf)
    for symbol in args.extra_symbols_30m_60m:
        for tf in ("30m", "60m"):
            fetch_symbol_tf(symbol, tf)


if __name__ == "__main__":
    sys.exit(main())
