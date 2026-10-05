"""Signal input checks and shared live/history warmup policy (no I/O)."""
from __future__ import annotations

import math
import re

TF_MINUTES = {"1m":1,"5m":5,"15m":15,"30m":30,"60m":60, "240m": 240,"1d":1440}


def invalid_bars(bars):
    for bar in bars:
        try:
            close = float(bar["close"])
            if not math.isfinite(close) or close <= 0: return True
            vals = {k:float(bar[k]) for k in ("open","high","low") if bar.get(k) is not None}
            if any(not math.isfinite(v) or v <= 0 for v in vals.values()): return True
            high, low = vals.get("high"), vals.get("low")
            prices = [close, vals.get("open",close)]
            if high is not None and high < max(prices): return True
            if low is not None and low > min(prices): return True
            if high is not None and low is not None and high < low: return True
            if bar.get("volume") is not None:
                volume = float(bar["volume"])
                if not math.isfinite(volume) or volume < 0: return True
        except (KeyError, TypeError, ValueError, OverflowError): return True
    return False


def required_signal_bars(strategy_type, timeframe, params=None):
    from strategies import normalize_strategy_params
    p = normalize_strategy_params(strategy_type, params)
    if strategy_type == "ma_cross":
        slow = int(p["slow_period"])
        return max(240, slow+1, slow*5 if p["ma_type"] == "ema" else 0)
    if strategy_type == "n_breakout": return max(240, int(p["lookback"])+1)
    if strategy_type == "macd_cross":
        return max(240, (int(p["slow_period"])+int(p["signal_period"]))*5+2)
    if strategy_type == "band_swing": return max(240, int(p["period"])+1)
    if strategy_type == "kdj_cross": return max(240, int(p["n_period"])+10*(int(p["k_period"])+int(p["d_period"])))
    if strategy_type in ("strength_entry","strength_entry_v2"):
        return max(240, sum(int(p.get(k) or 0) for k in ("period","smooth","smooth2","trend_ma_period","rebound_lookback","atr_period","exhaust_window","cooldown"))+100)
    if strategy_type == "factor":
        from factor_lab.ops import OPS_NAMES
        norm = max(200, math.ceil(1440/TF_MINUTES.get(timeframe,1440)))
        raw = p.get("factor_tokens") or []
        groups = raw if raw and isinstance(raw[0],list) else [raw]
        def history(g):
            offset = 128 if any(t >= 128 for t in g) else 64
            total = 0
            for token in g:
                if token >= offset and token-offset < len(OPS_NAMES):
                    nums = re.findall(r"\d+", OPS_NAMES[token-offset])
                    total += int(nums[-1]) if nums else 20
            return total
        return min(10000, max(600, 2*norm+180+max((history(g) for g in groups),default=0)))
    if strategy_type == "swing_pro":
        from strategies.swing_pro import resolve_htf_tf
        other = resolve_htf_tf(timeframe, params)
        short = min(TF_MINUTES.get(timeframe,5),TF_MINUTES.get(other,TF_MINUTES.get(timeframe,5)))
        long = max(TF_MINUTES.get(timeframe,5),TF_MINUTES.get(other,0))
        return min(10000, 240*max(1,long//short))
    # Pivot tasks retain their existing calculation/feed policy.
    return 240
