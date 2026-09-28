"""Fetch actual ETHUSDT perpetual 15m archive bars; no synthetic fallback.

2024-01..2025-12 contain 70,176 real quarter-hour bars. Freeze the first 70,174
with volume/direct fields and funding events; verify each archive SHA256.
"""
import argparse
import csv
import hashlib
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://data.binance.vision/data/futures/um/monthly"


def download(url):
    for attempt in range(3):
        try:
            with urlopen(url, timeout=90) as response:
                return response.read()
        except (TimeoutError, OSError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def fetch_archive(kind, month, cache):
    name = f"ETHUSDT-15m-{month}" if kind == "klines" else f"ETHUSDT-fundingRate-{month}"
    route = "klines/ETHUSDT/15m" if kind == "klines" else "fundingRate/ETHUSDT"
    url = f"{BASE}/{route}/{name}.zip"
    target = cache / (name + ".zip")
    checksum = cache / (name + ".CHECKSUM")
    if not target.exists():
        target.write_bytes(download(url))
    if not checksum.exists():
        checksum.write_bytes(download(url + ".CHECKSUM"))
    data = target.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != checksum.read_text().split()[0]:
        raise ValueError(f"Archive hash mismatch: {url}")
    with ZipFile(io.BytesIO(data)) as archive:
        text = archive.read(archive.namelist()[0]).decode("utf-8-sig")
    return kind, month, text, {"url": url, "sha256": digest}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=ROOT / ".local-data/bench-bars/ETHUSDT-15m-perp-70174.json")
    args = p.parse_args()
    cache = ROOT / ".local-data/native-gpu-archives"
    cache.mkdir(parents=True, exist_ok=True)
    jobs = [(kind, f"{year}-{month:02d}", cache) for year in (2024, 2025) for month in range(1, 13) for kind in ("klines", "fundingRate")]
    bars, funding, sources = {}, {}, []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for kind, month, text, source in pool.map(lambda job: fetch_archive(*job), jobs):
            sources.append(source)
            if kind == "klines":
                for row in csv.reader(io.StringIO(text)):
                    if not row or not row[0].isdigit():
                        continue
                    stamp = int(row[0])
                    if stamp > 10**14:
                        stamp //= 1000
                    bars[stamp] = {"time": datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat(),
                                   "open": float(row[1]), "high": float(row[2]), "low": float(row[3]),
                                   "close": float(row[4]), "volume": float(row[5]), "quote_volume": float(row[7]),
                                   "trade_count": float(row[8]), "taker_buy_volume": float(row[9]),
                                   "taker_buy_quote_volume": float(row[10])}
            else:
                for row in csv.DictReader(io.StringIO(text)):
                    stamp = row.get("calc_time") or row.get("fundingTime") or row.get("funding_time")
                    rate = row.get("last_funding_rate") or row.get("fundingRate") or row.get("funding_rate")
                    if stamp is None or rate is None:
                        raise ValueError(f"Unknown funding archive schema: {month}")
                    funding[int(stamp)] = float(rate)
            print(f"verified {kind} {month}", flush=True)
    stamps = sorted(bars)
    if len(stamps) != 70176 or any(b - a != 900000 for a, b in zip(stamps, stamps[1:])):
        raise ValueError("Real archive history is incomplete or discontinuous")
    events = sorted(funding.items())
    j, last = 0, None
    result = []
    for stamp in stamps[:70174]:
        while j < len(events) and events[j][0] <= stamp:
            last = events[j]
            j += 1
        bar = bars[stamp]
        if last is not None:
            bar["funding_time"], bar["funding_rate"] = last
        result.append(bar)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(result, separators=(",", ":"), allow_nan=False)
    args.out.write_text(encoded, encoding="utf-8")
    manifest = {"symbol": "ETHUSDT", "market": "perpetual", "timeframe": "15m", "count": len(result),
                "start": result[0]["time"], "end": result[-1]["time"],
                "sha256": hashlib.sha256(encoded.encode()).hexdigest(), "sources": sources}
    args.out.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in manifest.items() if k != "sources"}))


if __name__ == "__main__":
    main()
