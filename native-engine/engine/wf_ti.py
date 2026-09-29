"""Frozen resident contexts and GPU metrics for warmup slices and WF folds."""
from collections import OrderedDict

import taichi as ti

from factor_lab.market import is_crypto, is_v2
from factor_lab.features import bars_signature
from factor_lab.research_context import norm_window_for_bars
from factor_lab.scoring.periods import bars_per_year
from factor_lab.scoring.split_plan import plan_validation_folds
from .features_ti import compute_features
from .metrics_ti import NumericalReports
from .reductions_ti import block_tree_sum, compensated_add
from .series_ti import GpuSeries
from .vm_ti import StackVM, validate_tokens

MIN_TEST_BARS = 120
WARMUP_BARS = 250
_SEG_RESULTS = OrderedDict()


class GpuResearchContext:
    def __init__(self, bars, timeframe, cost, *, resident=None, cache_bytes=256 * 1024 * 1024):
        self.bars, self.timeframe, self.cost = bars, timeframe, float(cost)
        self.resident = resident if resident is not None else compute_features(bars)
        self.cache_bytes = cache_bytes
        self.contexts, self.signatures = OrderedDict(), {}
        self.prefetched_slices = {}
        from .batch_buffers import BatchBufferPool
        self.batch_pool = BatchBufferPool(cache_bytes)

    def signature(self, start, hi):
        key = (start, hi)
        if key not in self.signatures:
            # Metadata-only content identity, matching the CPU's global cache
            # across equal-content peer and primary contexts as well.
            self.signatures[key] = bars_signature(self.bars[start:hi])
        return self.signatures[key]

    def _context(self, start, hi, norm_window=None, *, recompute=False):
        # Crypto frozen contexts use the same causal resident prefix for signal,
        # discrete and executable reports. Keep nonzero warmup contexts separate.
        if start == 0 and is_crypto(self.bars):
            recompute = False
        key = (start, hi, norm_window, recompute)
        hit = self.contexts.get(key)
        if hit is not None:
            self.contexts.move_to_end(key)
            return hit
        bars = self.bars[start:hi]
        owned = bool(start or recompute)
        projected = ((self.resident.matrix.shape[0] if owned else 0)+27)*len(bars)*8+16384
        self.batch_pool.set_limit(max(0, self.cache_bytes-
            sum(x['bytes'] for x in self.contexts.values())-projected))
        features = compute_features(bars) if owned else self.resident.frozen_prefix(hi)
        v2 = is_v2(bars)
        window = norm_window if norm_window is not None else (norm_window_for_bars(bars) if v2 else 250)
        vm = StackVM(features.matrix, "f64", tile=1, norm_window=window,
                     normalization="causal_v2" if v2 else "legacy", bar_count=len(bars))
        reports = NumericalReports(bars, tile=1)
        hit = {"bars": bars, "features": features, "vm": vm, "reports": reports,
               "availability": features.availability(crypto=False), "last_tokens": None,
               "bytes": ((features.matrix.shape[0] if owned else 0) + 14 + 7 + 6) * len(bars) * 8 + 16384}
        self.contexts[key] = hit
        while len(self.contexts) > 1 and (len(self.contexts) > 8 or sum(x["bytes"] for x in self.contexts.values()) > self.cache_bytes):
            self.contexts.popitem(last=False)
        self.batch_pool.set_limit(max(0, self.cache_bytes-sum(x['bytes'] for x in self.contexts.values())))
        return hit

    def batch_buffers(self, data, width):
        self.batch_pool.set_limit(max(0, self.cache_bytes-sum(x['bytes'] for x in self.contexts.values())))
        return self.batch_pool.acquire(data, width)

    def factor_context(self, tokens, start, hi, norm_window=None, *, recompute=False):
        try:
            validate_tokens(tokens, self.resident.matrix.shape[0])
        except (ValueError, TypeError):
            return None
        data = self._context(start, hi, norm_window, recompute=recompute)
        availability = data["availability"]
        for token in tokens:
            if 52 <= token < 64 and not availability["finite_features"][token]:
                if not is_v2(data["bars"]) or not availability["continuous_features"][token]:
                    return None
        frozen = tuple(tokens)
        if data["last_tokens"] != frozen:
            data["vm"].dispatch([list(tokens)])
            data["last_tokens"] = frozen
        return data

    def cached(self, key, compute):
        if key in _SEG_RESULTS:
            _SEG_RESULTS.move_to_end(key)
            return _SEG_RESULTS[key]
        result = compute()
        _SEG_RESULTS[key] = result
        while len(_SEG_RESULTS) > 2048:
            _SEG_RESULTS.popitem(last=False)
        return result

    def dispose(self):
        self.batch_pool.dispose()
        self.contexts.clear()
        self.signatures.clear()
        self.prefetched_slices.clear()
        self.resident = self.bars = None


def _slice_start(context, tokens, lo):
    full = is_crypto(context.bars) or any(40 <= t < 64 or t >= 104 for t in tokens)
    return 0 if full else max(0, lo - WARMUP_BARS)


def evaluate_on_slice(context, tokens, lo, hi, cost=None):
    if hi-lo < MIN_TEST_BARS:
        return None
    cost = context.cost if cost is None else float(cost)
    start = _slice_start(context, tokens, lo)
    # Preserve the frozen CPU _SEG_CACHE contract: its key contains the
    # warmup context signature but omits the score offset. A train prefix
    # and a prior full-context test slice can therefore share a cached result.
    # Changing that observable behavior belongs to a separate CPU design fix.
    key = ("slice", tuple(tokens), context.signature(start, hi), context.timeframe, round(cost, 10))

    def calculate():
        from .slice_batch_ti import BatchSlices
        batch_key = BatchSlices.key(tokens, lo, hi, cost)
        if batch_key in context.prefetched_slices:
            result = context.prefetched_slices[batch_key]
            return dict(result) if result is not None else None
        data = context.factor_context(tokens, start, hi)
        if data is None:
            return None
        periods = bars_per_year(data["bars"][lo-start:], context.timeframe)
        factors, report = data["vm"].factors, data["reports"]
        base, opened, session = (rows[0] for rows in report.evaluate_slice_modes(factors, 1,
            lo-start, hi-start, cost, periods))
        return {name: base[name] for name in ("ann_ret", "sortino", "calmar", "ts_ic", "avg_turnover", "exposure", "bars")} | {
            "live_fill_ann_ret": opened["ann_ret"], "live_fill_sortino": opened["sortino"],
            "session_ann_ret": session["ann_ret"], "session_sortino": session["sortino"]}

    result = context.cached(key, calculate)
    return dict(result) if result is not None else None


def live_discrete_on_slice(context, tokens, lo, hi, entry, cost=None):
    if hi-lo < MIN_TEST_BARS:
        return None
    cost = context.cost if cost is None else float(cost)
    start = _slice_start(context, tokens, lo)
    key = ("live", tuple(tokens), context.signature(start, hi), context.timeframe, round(cost, 10), round(entry, 6))

    def calculate():
        data = context.factor_context(tokens, start, hi, recompute=True)
        if data is None:
            return None
        periods = bars_per_year(data["bars"][lo-start:], context.timeframe)
        base = data["reports"].evaluate(data["vm"].factors, 1, lo-start, hi-start, cost, periods,
                                         mode="discrete", entry=entry)[0]
        return {name: base[name] for name in ("ann_ret", "sortino", "n_trades", "exposure")}

    result = context.cached(key, calculate)
    return dict(result) if result is not None else None


def executable_on_slice(context, tokens, lo, hi, model, stress=1.0, cost=None):
    if hi-lo < 2 or hi < 3:
        return None
    cost = context.cost if cost is None else float(cost)
    key = ("executable", tuple(tokens), context.signature(0, hi), context.timeframe, lo, model, stress, round(cost, 10))

    def calculate():
        data = context.factor_context(tokens, 0, hi, recompute=True)
        if data is None:
            return None
        periods = bars_per_year(data["bars"][lo:hi], context.timeframe)
        base = data["reports"].evaluate(data["vm"].factors, 1, lo, hi, cost * stress, periods, mode=model)[0]
        if base is None:
            return None
        return {name: base[name] for name in ("ann_ret", "sortino", "calmar", "avg_turnover", "exposure", "fee_total",
                                               "funding_total", "n_funding_events", "funding_estimated", "bars")} | {
            "execution_model": model, "stress_multiplier": stress}

    result = context.cached(key, calculate)
    return dict(result) if result is not None else None


_fold_stats = None


def _moments(values):
    global _fold_stats
    if _fold_stats is None:
        _fold_stats = _FoldStats()
    values = GpuSeries.upload(values)
    result = ti.ndarray(ti.f64, shape=2)
    _fold_stats._mean(values.data, result)
    _fold_stats._std(values.data, result)
    ti.sync()
    return list(map(float, result.to_numpy()))


def walk_forward_eval(context, tokens, n_folds, train_len=None, *, plan=None, norm_window=250):
    if n_folds <= 0:
        return None
    folds, sortinos, anns, oos_sortinos, oos_anns = [], [], [], [], []
    if plan is None:
        n = len(context.bars)
        seg = n // (n_folds + 1)
        if seg < MIN_TEST_BARS:
            return None
        indices = [(i * seg, (i + 1) * seg if i < n_folds else n) for i in range(1, n_folds + 1)]
    else:
        indices = plan_validation_folds(plan, n_folds)
        if not indices:
            return None
    for a, b in indices:
        if plan is None:
            train = evaluate_on_slice(context, tokens, 0, a)
            test = evaluate_on_slice(context, tokens, a, b)
            if train is None or test is None:
                return None
            in_train = bool(train_len is not None and a < train_len)
            record = {"train": train, "test": test, "in_train": in_train}
            if in_train:
                record["overlap_train_bars"] = int(min(b, train_len) - a)
            if not in_train:
                oos_sortinos.append(test["sortino"])
                oos_anns.append(test["ann_ret"])
        else:
            if b-a < MIN_TEST_BARS:
                return None
            start = max(0, a-plan.warmup)
            data = context.factor_context(tokens, start, b, norm_window, recompute=True)
            if data is None:
                return None
            periods = bars_per_year(data["bars"][a-start:], context.timeframe)
            metrics = data["reports"].evaluate(data["vm"].factors, 1, a-start, b-start, context.cost, periods)[0]
            test = {name: metrics[name] for name in ("ann_ret", "sortino", "avg_turnover", "bars")}
            test.update(score_start=a, score_end=b, context_start=start)
            record = test
            oos_sortinos.append(test["sortino"])
            oos_anns.append(test["ann_ret"])
        folds.append(record)
        sortinos.append(test["sortino"])
        anns.append(test["ann_ret"])
    mean_ann, std_ann = _moments(oos_anns if oos_anns else anns)
    mean_sortino, _ = _moments(oos_sortinos if oos_sortinos else sortinos)
    return {"folds": folds, "wf_stable": all(value > 0.0 for value in oos_sortinos),
            "wf_mean_test_sortino": mean_sortino, "wf_mean_test_ann": mean_ann,
            "wf_consistency": 1.0-std_ann/(abs(mean_ann)+1e-9) if mean_ann != 0 else 0.0,
            "n_folds": int(n_folds), "n_oos_folds": len(oos_sortinos)}


@ti.data_oriented
class _FoldStats:
    @ti.kernel
    def _mean(self, values: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1)):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            total, correction = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            for chunk in range((values.shape[0]+255)//256):
                t = chunk * 256 + lane
                if t < values.shape[0]:
                    total, correction = compensated_add(total, correction, values[t])
            shared[lane, 0] = total
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[0] = shared[0, 0] / values.shape[0]

    @ti.kernel
    def _std(self, values: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1)):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            total, correction = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            for chunk in range((values.shape[0]+255)//256):
                t = chunk * 256 + lane
                if t < values.shape[0]:
                    delta = values[t]-out[0]
                    total, correction = compensated_add(total, correction, delta*delta)
            shared[lane, 0] = total
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[1] = ti.sqrt(shared[0, 0] / values.shape[0])
