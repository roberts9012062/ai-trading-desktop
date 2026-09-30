"""Freeze seven real perpetual histories x four timeframes for full G2.

Binance archive CHECKSUMs are verified. Larger timeframes are exact UTC OHLCV
aggregation of the same real quarter-hour records; incomplete groups fail.
No synthetic history or missing archive fallback is allowed.
"""
import argparse
import csv
import hashlib
import importlib.util
import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_archive', ROOT/'scripts/fetch-native-gpu-benchmark.py')
ARCHIVE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(ARCHIVE)
SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT')
FRAMES = {'15m': 1, '30m': 2, '60m': 4, '1d': 96}


def archive(symbol, kind, month, cache):
    name = f'{symbol}-15m-{month}' if kind=='klines' else f'{symbol}-fundingRate-{month}'
    route = f'klines/{symbol}/15m' if kind=='klines' else f'fundingRate/{symbol}'
    url = f'{ARCHIVE.BASE}/{route}/{name}.zip'
    target, checksum = cache/(name+'.zip'), cache/(name+'.CHECKSUM')
    if not target.exists():
        target.write_bytes(ARCHIVE.download(url))
    if not checksum.exists():
        checksum.write_bytes(ARCHIVE.download(url+'.CHECKSUM'))
    data = target.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != checksum.read_text().split()[0]:
        raise ValueError(f'Archive checksum mismatch: {url}')
    with ZipFile(io.BytesIO(data)) as z:
        text = z.read(z.namelist()[0]).decode('utf-8-sig')
    return kind, text, {'url': url, 'sha256': digest}


def aggregate(bars, width):
    if len(bars)%width:
        raise ValueError('Incomplete frozen aggregate group')
    result = []
    for a in range(0, len(bars), width):
        rows = bars[a:a+width]
        result.append({'time': rows[0]['time'], 'open_time': rows[0]['open_time'],
                       'open': rows[0]['open'], 'close': rows[-1]['close'],
                       'high': max(r['high'] for r in rows), 'low': min(r['low'] for r in rows),
                       **{key: sum(r[key] for r in rows) for key in ('volume', 'quote_volume', 'trade_count', 'taker_buy_volume', 'taker_buy_quote_volume')},
                       **{key: rows[-1][key] for key in ('funding_time', 'funding_rate') if key in rows[-1]}})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT/'.local-data/native-gpu-g2')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    cache = ROOT/'.local-data/native-gpu-archives'; cache.mkdir(parents=True, exist_ok=True)
    manifest = {'symbols': list(SYMBOLS), 'timeframes': list(FRAMES), 'cases': []}
    for symbol in SYMBOLS:
        bars, funding, sources = {}, {}, []
        jobs = [(symbol, kind, f'{year}-{month:02d}', cache) for year in (2024, 2025) for month in range(1, 13) for kind in ('klines', 'fundingRate')]
        with ThreadPoolExecutor(max_workers=4) as pool:
            for kind, text, source in pool.map(lambda job: archive(*job), jobs):
                sources.append(source)
                if kind=='klines':
                    for row in csv.reader(io.StringIO(text)):
                        if not row or not row[0].isdigit():
                            continue
                        stamp = int(row[0]); stamp = stamp//1000 if stamp>10**14 else stamp
                        bars[stamp] = {'time': datetime.fromtimestamp(stamp/1000, timezone.utc).isoformat(),
                                       'open_time': stamp, 'open': float(row[1]), 'high': float(row[2]), 'low': float(row[3]),
                                       'close': float(row[4]), 'volume': float(row[5]), 'quote_volume': float(row[7]),
                                       'trade_count': float(row[8]), 'taker_buy_volume': float(row[9]), 'taker_buy_quote_volume': float(row[10])}
                else:
                    for row in csv.DictReader(io.StringIO(text)):
                        stamp = row.get('calc_time') or row.get('fundingTime') or row.get('funding_time')
                        rate = row.get('last_funding_rate') or row.get('fundingRate') or row.get('funding_rate')
                        if stamp is None or rate is None:
                            raise ValueError('Unknown funding archive schema')
                        funding[int(stamp)] = float(rate)
                print(f'verified {symbol} {source["url"].rsplit("/", 1)[-1]}', flush=True)
        stamps = sorted(bars)
        if len(stamps)!=70176 or any(b-a!=900000 for a,b in zip(stamps, stamps[1:])):
            raise ValueError(f'Incomplete or discontinuous history: {symbol}')
        events, j, last = sorted(funding.items()), 0, None
        records = []
        for stamp in stamps:
            while j<len(events) and events[j][0]<=stamp:
                last = events[j]; j += 1
            row = bars[stamp]
            if last is not None:
                row['funding_time'], row['funding_rate'] = last
            records.append(row)
        for frame, width in FRAMES.items():
            key = f'{symbol}-{frame}'
            rows = records[:70174] if width==1 else aggregate(records, width)
            # Retain the exact M1 anchor bytes and all 3000 regression tokens.
            anchor = ROOT/'.local-data/bench-bars/ETHUSDT-15m-perp-70174.json'
            encoded = anchor.read_bytes() if symbol=='ETHUSDT' and frame=='15m' else json.dumps(rows, separators=(',', ':'), allow_nan=False).encode()
            (args.out/(key+'.bars.json')).write_bytes(encoded)
            v2 = frame in ('30m', '60m')
            config = {'symbol': symbol, 'timeframe': frame, 'crypto_profile': True, 'population': 3000,
                      'generations': 100, 'max_depth': 6, 'seed': 42, 'train_ratio': .7, 'test_recent_bars': 0,
                      'walk_forward_folds': 2, 'cost': .0003, 'top_n': 10,
                      'selection_v2': frame=='15m', 'research_profile': 'crypto_local_v2' if v2 else 'crypto_ohlcv_v1',
                      'execution_model': 'perp_next_open' if frame=='30m' else 'signal_research'}
            (args.out/(key+'.config.json')).write_text(json.dumps(config, indent=2), encoding='utf-8')
            token_path = args.out/(key+'.tokens.json')
            if symbol=='ETHUSDT' and frame=='15m' and not token_path.exists():
                m1 = ROOT/'.local-data/native-gpu-reports/m1-candidates.json'
                # M1 锚点候选缺失时(本地 .local-data 不入库)走与其它 case 相同的
                # 参考页生成路径;重导出的候选集随本次重冻结一同固定。
                if m1.exists():
                    token_path.write_bytes(m1.read_bytes())
            case = {'symbol': symbol, 'timeframe': frame, 'bars': key+'.bars.json', 'config': key+'.config.json',
                    'candidates': key+'.tokens.json', 'cpu_reference': key+'.cpu.json',
                    'count': len(rows), 'bars_sha256': hashlib.sha256(encoded).hexdigest(),
                    'aggregation': width, 'sources': sources}
            manifest['cases'].append(case)
        # Save progress after each complete symbol; full G2 refuses partial 7x4.
        (args.out/'suite.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'cases': len(manifest['cases']), 'manifest': str(args.out/'suite.json')}))


if __name__ == '__main__':
    main()
