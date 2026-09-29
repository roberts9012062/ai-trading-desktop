"""All 62 CPU-contract feature rows computed on resident CUDA f64 arrays.

The host parses input records and timestamp metadata. Numerical feature
operations, normalization, missing masks and matrix assembly run on CUDA.
"""
from datetime import date
import math

import taichi as ti

from factor_lab.features import FEATURE_NAMES, zscore_window
from factor_lab.market import is_v2, utc_time
from .series_ti import GpuSeries, program
from .reductions_ti import block_tree_sum, compensated_add

_stats_program = None


class GpuFeatureMatrix:
    def __init__(self, rows):
        self.matrix = ti.ndarray(ti.f64, shape=(len(rows), rows[0].T))
        self.visible_length = rows[0].T
        for f, row in enumerate(rows):
            _copy_row(row.data, self.matrix, f)
        # Release the intermediate dependency graph only after assembly.
        ti.sync()

    def to_numpy(self):
        ti.sync()
        return self.matrix.to_numpy()[:, :self.visible_length]

    def frozen_prefix(self, hi):
        if type(hi) is not int or not 1 <= hi <= self.visible_length:
            raise ValueError('Invalid shared feature prefix')
        if hi == self.visible_length:
            return self
        result = object.__new__(GpuFeatureMatrix)
        result.matrix, result.visible_length = self.matrix, hi
        return result

    def prefix(self, hi):
        if type(hi) is not int or not 1 <= hi <= self.visible_length:
            raise ValueError("Invalid resident feature prefix")
        if hi == self.visible_length:
            return self
        result = object.__new__(GpuFeatureMatrix)
        result.matrix = ti.ndarray(ti.f64, shape=(self.matrix.shape[0], hi))
        result.visible_length = hi
        _copy_prefix(self.matrix, result.matrix)
        return result

    def availability(self, hi=None, *, crypto=False, max_head_gap=None):
        hi = self.visible_length if hi is None else hi
        if type(hi) is not int or not 1 <= hi <= self.visible_length:
            raise ValueError("Invalid feature availability prefix")
        global _stats_program
        if _stats_program is None:
            _stats_program = _FeatureStats()
        F = self.matrix.shape[0]
        summary = ti.ndarray(ti.f64, shape=(F, 3))
        deviation = ti.ndarray(ti.f64, shape=F)
        _stats_program._means(self.matrix, summary, hi)
        _stats_program._deviation(self.matrix, summary, deviation, hi)
        ti.sync()
        # Only small per-row scalar metadata crosses back to the host.
        rows, std = summary.to_numpy(), deviation.to_numpy()
        heads = [int(row[1]) for row in rows]
        finite = [int(row[0]) == hi for row in rows]
        continuous = [int(row[0]) > 0 and int(row[0]) == hi - heads[f]
                      for f, row in enumerate(rows)]
        active = list(range(min(40, F)))
        if crypto:
            active = [f for f in range(F) if f not in (17, 18, 33, 34)
                      and continuous[f] and std[f] > 1e-8
                      and (finite[f] or (max_head_gap is not None and heads[f] <= max_head_gap))]
            if not active:
                raise ValueError("No usable nonconstant training features")
        trim = max((heads[f] for f in active if f >= 52 and not finite[f]), default=0)
        return {"active_feature_ids": active, "head_trim": trim,
                "finite_features": finite, "continuous_features": continuous,
                "feature_heads": heads}


@ti.kernel
def _copy_row(source: ti.types.ndarray(dtype=ti.f64, ndim=1), matrix: ti.types.ndarray(dtype=ti.f64, ndim=2), f: ti.i32):
    for t in range(source.shape[0]):
        matrix[f, t] = source[t]


@ti.kernel
def _copy_prefix(source: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2)):
    for f, t in ti.ndrange(out.shape[0], out.shape[1]):
        out[f, t] = source[f, t]


@ti.data_oriented
class _FeatureStats:
    def __init__(self):
        self.math = program().math

    @ti.kernel
    def _means(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), hi: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(source.shape[0] * 256):
            f, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 3), ti.f64)
            count, total, correction = 0, ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            first = hi
            for chunk in range((hi + 255) // 256):
                t = chunk * 256 + lane
                if t < hi and self.math.is_finite(source[f, t]):
                    count = count + 1
                    first = ti.min(first, t)
                    total, correction = compensated_add(total, correction, source[f, t])
            shared[lane, 0], shared[lane, 1], shared[lane, 2] = count, first, total
            ti.simt.block.sync()
            for step in ti.static((128, 64, 32, 16, 8, 4, 2, 1)):
                if lane < step:
                    shared[lane, 0] = shared[lane, 0] + shared[lane + step, 0]
                    shared[lane, 1] = ti.min(shared[lane, 1], shared[lane + step, 1])
                    shared[lane, 2] = shared[lane, 2] + shared[lane + step, 2]
                ti.simt.block.sync()
            if lane == 0:
                out[f, 0], out[f, 1] = shared[0, 0], shared[0, 1]
                out[f, 2] = self.math.divide(shared[0, 2], ti.max(1.0, shared[0, 0]), 0)

    @ti.kernel
    def _deviation(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), summary: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=1), hi: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(source.shape[0] * 256):
            f, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            total, correction = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            for chunk in range((hi + 255) // 256):
                t = chunk * 256 + lane
                if t < hi and self.math.is_finite(source[f, t]):
                    delta = source[f, t] - summary[f, 2]
                    total, correction = compensated_add(total, correction, delta * delta)
            shared[lane, 0] = total
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[f] = ti.sqrt(shared[0, 0] / ti.max(1.0, summary[f, 0]))


def _clock_rows(bars):
    minutes, weekdays, monthdays, utc_minutes, utc_weekdays, hourly = [], [], [], [], [], []
    for bar in bars:
        text = str(bar.get("time") or "").strip()
        minute = -1
        if len(text) >= 16:
            try:
                minute = int(text[11:13]) * 60 + int(text[14:16])
            except ValueError:
                pass
        minutes.append(minute)
        try:
            d = date.fromisoformat(text[:10])
            weekdays.append(d.weekday())
            monthdays.append(d.day)
        except ValueError:
            weekdays.append(-1)
            monthdays.append(-1)
        dt = utc_time(bar.get("time", ""))
        utc_minutes.append(dt.hour * 60 + dt.minute if dt else -1)
        utc_weekdays.append(dt.weekday() if dt else -1)
        hourly.append(float(dt is not None and len(str(bar.get("time", ""))) > 10))
    minute, dow, dom = map(GpuSeries.upload, (minutes, weekdays, monthdays))
    umin, udow, has_hour = map(GpuSeries.upload, (utc_minutes, utc_weekdays, hourly))
    # Modulo is expressed on the device; the parsed raw clock can include an
    # out-of-range hour exactly as the legacy parser permits.
    elapsed = minute.unary(11)
    hour_phase = (2 * math.pi * umin) / 1440.0
    week_phase = (2 * math.pi * udow) / 7.0
    return {
        "TOD": minute.ge(0).where((elapsed / 1080.0).minimum(1.0) * 2.0 - 1.0, 0.0),
        "NIGHT": minute.ge(0).where((minute.ge(1260) + minute.lt(180)).gt(0), 0.0),
        "DOW": dow.ge(0).where((dow - 2.0) / 2.0, 0.0),
        "DOM": dom.ge(0).where((dom - 15.5) / 15.5, 0.0),
        "UTC_HOUR_SIN": has_hour.where(hour_phase.sin(), 0.0).round(7),
        "UTC_HOUR_COS": has_hour.where(hour_phase.cos(), 0.0).round(7),
        "UTC_WEEK_SIN": udow.ge(0).where(week_phase.sin(), 0.0).round(7),
        "UTC_WEEK_COS": udow.ge(0).where(week_phase.cos(), 0.0).round(7),
        "UTC_WEEKEND": udow.ge(5).round(7),
    }


def compute_features(bars):
    if not bars:
        raise ValueError("Cannot compute an empty feature matrix")
    T = len(bars)

    def raw(key):
        return GpuSeries.upload([float(b.get(key) or 0) for b in bars])

    def direct(key):
        return GpuSeries.upload([float(b[key]) if b.get(key) is not None else float("nan") for b in bars])

    close, high, low, open_, volume = map(raw, ("close", "high", "low", "open", "volume"))
    zeros = GpuSeries.full(T, 0.0)
    oi_present = GpuSeries.upload([float(b.get("open_interest") is not None) for b in bars])
    oi_raw = direct("open_interest")
    oi = oi_raw.forward_fill(oi_present)
    # Availability of an input column is transport metadata, not a feature
    # calculation; the forward-fill numerical recurrence remains on CUDA.
    has_oi = any(b.get("open_interest") is not None for b in bars)
    r, ma20, std20 = close.ret(1), close.mean(20), close.std(20)
    ma60, std60, vol_ma, vol_std = close.mean(60), close.std(60), volume.mean(20), volume.std(20)
    oi_delta = oi.delta(1)
    rng, denominator = (high - low).maximum(1e-9), close.maximum(1e-9)
    previous = close.lag(1, first=True)
    tr = (high - low).maximum((high - previous).abs().maximum((low - previous).abs()))
    delta = close.delta(1)
    up, down = delta.gt(0).where(delta, 0.0), delta.lt(0).where(-delta, 0.0)
    rs = up.mean(14) / down.mean(14).maximum(1e-9)
    rsi = ((100.0 - 100.0 / (1.0 + rs)) - 50.0) / 50.0
    gap = (open_ - previous) / previous.abs().maximum(1e-9)
    index = GpuSeries.upload(range(T))
    gap = index.ge(1).where(gap, 0.0)
    tp = (high + low + close) / 3.0
    vwap = (tp * volume).mean(20) / vol_ma.maximum(1e-9)
    positive, negative = r.gt(0).where(r, 0.0), r.lt(0).where(-r, 0.0)
    su, sd = (positive * positive).mean(20), (negative * negative).mean(20)
    hh, ll = high.maximum_window(20), low.minimum_window(20)
    channel = (close - ll) / (hh - ll).maximum(1e-9) * 2.0 - 1.0
    values = {
        "RET": r, "RET5": close.ret(5), "RET20": close.ret(20),
        "MA_DIFF": (close - ma20) / ma20.abs().maximum(1e-9),
        "SLOPE20": ma20.delta(5) / ma20.abs().maximum(1e-9),
        "ATR14": tr.mean(14) / denominator,
        "RVOL": vol_std / vol_ma.maximum(1e-9),
        "HL_RANGE": (high - low) / denominator,
        "DEV": (close - ma20) / std20.maximum(1e-9), "RSI14": rsi,
        "AC1": r.autocorr(20), "VOL_RATIO": volume / vol_ma.maximum(1e-9),
        "VOL_Z": (volume - vol_ma) / vol_std.maximum(1e-9), "PV_CORR": r.corr(volume, 20),
        "OI_CHG": oi_delta / oi.abs().maximum(1.0) if has_oi else zeros,
        "OI_PV": r.sign() * oi_delta.sign() if has_oi else zeros,
        "VOL_OI": volume / oi.maximum(1.0) if has_oi else zeros,
        "GAP": gap, "CLOSE_POS": (close - low) / rng,
        "UPPER_SHADOW": (high - open_.maximum(close)) / denominator,
        "LOWER_SHADOW": (open_.minimum(close) - low) / denominator,
        "BODY": (close - open_) / denominator, "RET60": close.ret(60),
        "MA_DIFF60": (close - ma60) / ma60.abs().maximum(1e-9),
        "VOLAT_RATIO": std20 / std60.maximum(1e-9),
        "OI_PC": r.corr(oi_delta, 20) if has_oi else zeros,
        "OI_CHG5": oi.delta(5) / oi.abs().maximum(1.0) if has_oi else zeros,
        "OI_CHG20": oi.delta(20) / oi.abs().maximum(1.0) if has_oi else zeros,
        "VOL_OI_MA": (volume / oi.maximum(1.0)).mean(20) if has_oi else zeros,
        "SKEW20": r.moment(20, 3), "KURT20": r.moment(20, 4),
        "STRENGTH": close.strength(high, low), "STREAK": close.streak(),
        "VWAP_DEV": (close - vwap) / vwap.abs().maximum(1e-9),
        "UPDOWN_VOL_RATIO": (su - sd) / (su + sd).maximum(1e-12), "CHAN_POS": channel,
    }
    window = zscore_window(bars)
    out = {name: row.zscore(window) for name, row in values.items()}
    out.update(_clock_rows(bars))
    vol = r.std(20)
    amount = (close * volume).maximum(1e-9)
    crypto = {
        "CRYPTO_MOM6": close.ret(6) / (vol * math.sqrt(6)).maximum(1e-8),
        "CRYPTO_MOM24": close.ret(24) / (vol * math.sqrt(24)).maximum(1e-8),
        "CRYPTO_VOL20": vol,
        "CRYPTO_ILLIQ20": (r.abs() / amount).mean(20).maximum(1e-30).log(),
        "CRYPTO_FLOW20": (r.sign() * volume).mean(20) / vol_ma.maximum(1e-9),
        "CRYPTO_TAIL20": (r.minimum(0) * r.minimum(0)).mean(20) / (r * r).mean(20).maximum(1e-12),
        "CRYPTO_RANGE_POS20": channel,
    }
    out.update({name: row.zscore(200) for name, row in crypto.items()})
    funding, quote, flow, count = map(direct, ("funding_rate", "quote_volume", "taker_imbalance", "trade_count"))
    buy = direct("taker_buy_volume")
    transport_volume = direct("volume")
    valid_buy = transport_volume.ge(0) * buy.ge(0) * buy.le(transport_volume)
    replacement_flow = transport_volume.gt(0).where(2 * buy / transport_volume - 1.0, 0.0)
    flow = valid_buy.where(replacement_flow, flow)
    valid_quote = quote.isfinite() * quote.ge(0)
    illiq = (r.abs() / valid_quote.where(quote, 0.0).maximum(1e-9)).mean(20)
    illiq = valid_quote.mean(20).eq(1).where(illiq, float("nan"))
    average = count.gt(0).where(quote / count, float("nan"))
    average = (count.eq(0) * quote.eq(0)).where(0.0, average)
    log_oi = (oi_raw.isfinite() * oi_raw.gt(0)).where(oi_raw.gt(0).where(oi_raw, 1.0).log(), float("nan"))
    oi_chg24 = index.ge(24).where(log_oi.delta(24), float("nan"))
    ret24 = r.mean(24, masked=True) * 24.0
    direct_rows = {
        "FUNDING_RATE": funding, "FUNDING_DELTA": funding - funding.lag(1, first=True),
        "TAKER_IMBALANCE": flow, "QUOTE_ILLIQ20": illiq.maximum(1e-30).log(),
        "ACCOUNT_LS_RATIO": direct("long_short_ratio"),
        "LIQUIDATION_IMBALANCE": direct("liquidation_imbalance"),
        "AVG_TRADE_QUOTE": average, "FUNDING_MEAN24": funding.mean(24, masked=True),
        "OI_TREND24": oi_chg24 * ret24.sign(), "TAKER_IMB24": flow.mean(24, masked=True),
    }
    for name, row in direct_rows.items():
        if is_v2(bars):
            out[name] = row.zscore(200, masked=True)
        elif not row.any_finite():
            out[name] = zeros
        else:
            good = row.isfinite()
            out[name] = good.where(good.where(row, 0.0).zscore(200), float("nan"))
    return GpuFeatureMatrix([out[name] for name in FEATURE_NAMES])


def prepare_features(bars, config):
    """Freeze CPU-contract split/cost metadata around GPU feature computation."""
    from dataclasses import fields
    import factor_local
    from factor_lab.market import prepare_bars
    from factor_lab.research_context import norm_window_for_bars
    from factor_lab.scoring.periods import bars_per_year
    from factor_lab.scoring.walk_forward import frozen_view
    from factor_lab.search import SearchConfig

    prepared_bars = prepare_bars(config, bars)
    known = {field.name for field in fields(SearchConfig)}
    cfg = SearchConfig(**{k: v for k, v in config.items() if k in known and k != "cost"})
    train, _ = factor_local._split_train_test(cfg, prepared_bars)
    train = frozen_view(prepared_bars, len(train))
    resident = compute_features(prepared_bars)
    train_features = resident.prefix(len(train))
    v2 = cfg.research_profile == "crypto_local_v2"
    availability = resident.availability(len(train), crypto=cfg.crypto_profile or v2,
                                         max_head_gap=250 if v2 else 0)
    return {"matrix": train_features.matrix,
            "resident_full": resident, "bars": prepared_bars, "cfg": cfg,
            "availability": availability,
            "close": [float(b.get("close") or 0) for b in train],
            "periods": bars_per_year(train, str(config.get("timeframe") or "1d")),
            "cost": factor_local.resolve_search_cost(config, prepared_bars),
            "feature_names": list(FEATURE_NAMES),
            "active_feature_ids": availability["active_feature_ids"],
            "train_len": len(train), "total_len": len(bars),
            "head_trim": availability["head_trim"] if v2 else 0,
            "norm_window": norm_window_for_bars(train) if v2 else 250,
            "normalization": "causal_v2" if v2 else "legacy",
            "features_source": "gpu-taichi"}
