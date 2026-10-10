"""Server-token-compatible intrabar score RPC. No order execution in the worker."""
import json
import math
from crypto_factor import _latest_position


def run(payload_json, bars_json):
    p = json.loads(payload_json)
    bars = json.loads(bars_json)
    # History remains immutable. The caller supplies a fresh authoritative
    # forming candle; project cumulative volume by elapsed fraction explicitly.
    if bars and not bars[-1].get('is_closed', False):
        last = dict(bars[-1])
        scale = min(float(p.get('volume_scale', 1)), 90000.0)
        for field in ('volume','quote_volume','taker_buy_volume','taker_buy_quote_volume','trade_count'):
            if last.get(field) is not None:
                last[field] = float(last[field]) * scale
        bars = bars[:-1]+[last]
    params = p.get('params') or {}
    score = _latest_position(bars,params.get('factor_tokens') or [],params.get('factor_weights'))
    if score is None or not math.isfinite(score):
        raise ValueError('因子数据不足或评分无效')
    return json.dumps({'score':score})
