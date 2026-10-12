"""Frozen 2026 independent sample; official USD-M archives and SHA256 checksums."""
import csv
import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.local-data/factor-independent'
CACHE = OUT / 'archives'
BASE = 'https://data.binance.vision/data/futures/um/monthly'
MONTHS = [f'2026-{i:02}' for i in range(1, 10)]


def download(url):
    with urlopen(url, timeout=45) as r:
        return r.read()


def archive(job):
    symbol, kind, month = job
    name = f'{symbol}-1h-{month}' if kind == 'klines' else f'{symbol}-fundingRate-{month}'
    route = f'klines/{symbol}/1h' if kind == 'klines' else f'fundingRate/{symbol}'
    url = f'{BASE}/{route}/{name}.zip'
    path = CACHE / f'{name}.zip'
    payload = path.read_bytes() if path.exists() else download(url)
    digest = hashlib.sha256(payload).hexdigest()
    checksum = download(url + '.CHECKSUM').decode().split()[0]
    if digest != checksum:
        raise ValueError(f'Checksum mismatch: {url}')
    path.write_bytes(payload)
    with ZipFile(io.BytesIO(payload)) as z:
        rows = list(csv.reader(io.StringIO(z.read(z.namelist()[0]).decode('utf-8-sig'))))
    return rows, {'url': url, 'sha256': digest, 'official_checksum_verified': True}


def fetch(symbol):
    sources, bars, funding = [], {}, {}
    jobs = [(symbol, 'klines', month) for month in MONTHS]
    jobs += [(symbol, 'fundingRate', month) for month in ['2025-12', *MONTHS]]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for job, (rows, source) in zip(jobs, pool.map(archive, jobs)):
            sources.append(source)
            kind = job[1]
            for row in rows:
                if not row or not row[0].isdigit():
                    continue
                stamp = int(row[0])
                stamp = stamp // 1000 if stamp > 10**14 else stamp
                if kind == 'fundingRate':
                    # calc_time, funding_interval_hours, last_funding_rate
                    funding[stamp] = float(row[2])
                    continue
                bars[stamp] = {'time': datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat(),
                               'open_time': stamp, 'open': float(row[1]), 'high': float(row[2]),
                               'low': float(row[3]), 'close': float(row[4]), 'volume': float(row[5]),
                               'quote_volume': float(row[7]), 'trade_count': float(row[8]),
                               'taker_buy_volume': float(row[9]), 'market_source': 'binance_usdt'}
    stamps = sorted(bars)
    if any(b - a != 3_600_000 for a, b in zip(stamps, stamps[1:])):
        raise ValueError(f'{symbol}: non-contiguous hourly candles')
    events, i = sorted(funding), -1
    for stamp in stamps:
        while i + 1 < len(events) and events[i + 1] <= stamp:
            i += 1
        if i < 0 or stamp - events[i] > 12 * 3_600_000:
            raise ValueError(f'{symbol}: missing/stale funding at {stamp}')
        bars[stamp].update(funding_rate=funding[events[i]], funding_time=events[i])
    target = OUT / f'{symbol}-1h-2026.json'
    raw = json.dumps([bars[t] for t in stamps], separators=(',', ':')).encode()
    target.write_bytes(raw)
    manifest = {'symbol': symbol, 'market': 'USD-M perpetual', 'timeframe': '1h',
                'count': len(stamps), 'start': bars[stamps[0]]['time'], 'end': bars[stamps[-1]]['time'],
                'sha256': hashlib.sha256(raw).hexdigest(), 'sources': sources,
                'funding_settlement_events': len([t for t in events if stamps[0] <= t <= stamps[-1]]),
                'open_interest': 'unavailable; excluded, never synthesized'}
    target.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
    print(json.dumps({k: manifest[k] for k in ('symbol', 'count', 'start', 'end', 'funding_settlement_events')}), flush=True)


if __name__ == '__main__':
    CACHE.mkdir(parents=True, exist_ok=True)
    for symbol in ('XRPUSDT', 'ADAUSDT', 'DOGEUSDT'):
        fetch(symbol)
