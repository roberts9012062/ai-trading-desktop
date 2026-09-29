"""Resident f64 selection/report statistics with fixed compensated GPU trees."""
import math
from statistics import NormalDist

import taichi as ti

from .reductions_ti import block_tree_sum, compensated_add, clipped_sortino
from .series_ti import GpuSeries
from .vm_ti import _StackProgram
from .wf_ti import _FoldStats

_program = None
_stats = None


def program():
    global _program
    if _program is None:
        _program = _SelectionProgram()
    return _program


def copy_factor(matrix, row, lo=0, hi=None):
    hi = matrix.shape[1] if hi is None else hi
    if not 0 <= row < matrix.shape[0] or not 0 <= lo < hi <= matrix.shape[1]:
        raise ValueError('Invalid resident factor slice')
    out = ti.ndarray(ti.f64, shape=hi-lo)
    program()._copy_factor(matrix, out, row, lo)
    return GpuSeries(out)


def as_factor(series):
    out = ti.ndarray(ti.f64, shape=(1, series.T))
    program()._as_factor(series.data, out)
    return out


def copy_flow(flows, row, lo, hi):
    out = ti.ndarray(ti.f64, shape=hi-lo)
    program()._copy_flow(flows, out, row, lo)
    return GpuSeries(out)


def moments(series):
    global _stats
    if _stats is None:
        _stats = _FoldStats()
    # The sidecar has one serialized CUDA executor; readback completes before
    # another statistic can reuse this scratch buffer.
    out = program().moment_output
    _stats._mean(series.data, out)
    _stats._std(series.data, out)
    ti.sync()
    return list(map(float, out.to_numpy()))


def correlated(a, b):
    if a is None or b is None or a.T != b.T:
        return False
    fa, ga = a-moments(a)[0], b-moments(b)[0]
    sd = moments(fa)[1] * moments(ga)[1]
    if sd < 1e-12:
        return True
    return abs(moments(fa*ga)[0]/sd) > .9


class CenteredFactor:
    """Task-frozen factor's original centering/std, computed once on GPU."""
    def __init__(self, series):
        self.T = series.T
        self.centered = series-moments(series)[0]
        self.sd = moments(self.centered)[1]


def correlated_centered(a, b):
    if a is None or b is None or a.T != b.T:
        return False
    sd = a.sd*b.sd
    if sd < 1e-12:
        return True
    target = program()
    target._dot_mean(a.centered.data, b.centered.data, target.dot_output, 0)
    ti.sync()
    return abs(float(target.dot_output.to_numpy()[0])/sd) > .9


class CorrelationBank:
    """One fixed tree per prior factor, dispatched together for GPU occupancy."""
    def __init__(self, size, capacity):
        self.matrix = ti.ndarray(ti.f64, shape=(capacity, size))
        self.dots = ti.ndarray(ti.f64, shape=capacity)
        self.size, self.capacity, self.stds = size, capacity, []

    def append(self, factor):
        if factor.T != self.size or len(self.stds) >= self.capacity:
            raise ValueError('Correlation bank dimension/capacity exceeded')
        program()._copy_center_row(factor.centered.data, self.matrix, len(self.stds))
        self.stds.append(factor.sd)

    def any_correlated(self, factor):
        if not self.stds or factor is None or factor.T != self.size:
            return False
        program()._dot_many(factor.centered.data, self.matrix, self.dots, len(self.stds), 0)
        ti.sync()
        values = self.dots.to_numpy()[:len(self.stds)]
        return any(factor.sd*sd < 1e-12 or abs(float(value)/(factor.sd*sd)) > .9
                   for value, sd in zip(values, self.stds))


def pnl_stats(pnl, periods, lo=0, hi=None, mask=None):
    hi = pnl.T if hi is None else hi
    if not 0 <= lo < hi <= pnl.T:
        raise ValueError('Invalid pnl statistic range')
    out = program().pnl_output
    program()._pnl_stats(pnl.data, pnl.data if mask is None else mask.data, out,
                         lo, hi, int(mask is not None), float(periods))
    ti.sync()
    count, ann, sortino = map(float, out.to_numpy())
    return {'bars': int(count), 'ann_ret': ann, 'sortino': sortino}


def block_robustness(reports, factors, cost, periods):
    n = factors.shape[1]
    if n < 80:
        return 1.0, 0.0
    # Calculate once over the whole train segment: quarter boundaries must
    # retain the previous position and next-bar return of the CPU oracle.
    reports._cashflows(factors, 1, 0, n, cost, 'close', .3, 1.0)
    pnl = copy_flow(reports.flows, 0, 0, n)
    q = n//4
    sors = [pnl_stats(pnl, periods, k*q, (k+1)*q if k<3 else n)['sortino'] for k in range(4)]
    return sum(s > 0 for s in sors)/4, min(sors)


def dsr(pnl, trials):
    if pnl.T < 30:
        return None
    mean, sd = moments(pnl)
    if sd < 1e-12:
        return None
    z = (pnl-mean)/sd
    skew = moments(z.power(3))[0]
    kurt = moments(z.power(4))[0]
    sr = mean/sd
    denom = 1-skew*sr+(kurt-1)/4*sr*sr
    if denom <= 1e-12:
        return None
    # These are scalar probability/report formulas. All sequence moments
    # above are computed on CUDA, as required by the frozen design's scalar
    # logic exception; no numpy series scoring is used.
    sr0 = 0.0
    if trials > 1:
        gamma, nd = .5772156649015329, NormalDist()
        n = float(trials)
        sr0 = ((1-gamma)*nd.inv_cdf(1-1/n)+gamma*nd.inv_cdf(1-1/(n*math.e)))/math.sqrt(pnl.T-1)
    return float(NormalDist().cdf((sr-sr0)*math.sqrt(pnl.T-1)/math.sqrt(denom)))


def prepare_regime_masks(close):
    """Price-only GPU metadata shared by all reports of this frozen calendar."""
    index = GpuSeries.upload(range(close.T))
    ret1 = index.ge(1).where(close/close.lag(1, first=True).abs().maximum(1e-9)-1, 0)
    rew = index.ge(60).where(close/close.lag(60, first=True).abs().maximum(1e-9)-1, 0)
    threshold = ret1.std(60)*math.sqrt(60)
    valid = index.ge(60)
    up, down = valid*rew.gt(threshold), valid*rew.lt(-threshold)
    chop = (up+down).eq(0)
    return {name: mask*index.ge(1) for name, mask in
            (('trend_up', up), ('trend_down', down), ('chop', chop))}


def regime_report(close, pnl, periods, *, masks=None):
    if close.T != pnl.T:
        raise ValueError('Regime cashflow length mismatch')
    masks = prepare_regime_masks(close) if masks is None else masks
    if (set(masks) != {'trend_up', 'trend_down', 'chop'}
            or any(mask.T != close.T for mask in masks.values())):
        raise ValueError('Invalid frozen regime masks')
    result = {}
    for name, mask in masks.items():
        stats = pnl_stats(pnl, periods, mask=mask)
        count = stats['bars']
        result[name] = {'bars': count, 'sortino': round(stats['sortino'], 3) if count>=30 else None,
                        'ann_ret': round(stats['ann_ret'], 4) if count>=30 else None}
    return result


@ti.data_oriented
class _SelectionProgram:
    def __init__(self):
        self.math = _StackProgram('f64')
        self.dot_output = ti.ndarray(ti.f64, shape=1)
        self.moment_output = ti.ndarray(ti.f64, shape=2)
        self.pnl_output = ti.ndarray(ti.f64, shape=3)

    @ti.kernel
    def _copy_center_row(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=2), row: ti.i32):
        for t in range(source.shape[0]):
            out[row, t] = source[t]

    @ti.kernel
    def _dot_many(self, a: ti.types.ndarray(dtype=ti.f64, ndim=1), bank: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=1), count: ti.i32, guard: ti.i64):
        ti.loop_config(block_dim=256)
        for index in range(count*256):
            row, lane = index//256, index%256
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            total, correction = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            for chunk in range((a.shape[0]+255)//256):
                t = chunk*256+lane
                if t < a.shape[0]:
                    value = self.math.rounded(a[t]*bank[row, t], guard)
                    total, correction = compensated_add(total, correction, value)
            shared[lane, 0] = total
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[row] = shared[0, 0]/a.shape[0]

    @ti.kernel
    def _dot_mean(self, a: ti.types.ndarray(dtype=ti.f64, ndim=1), b: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), guard: ti.i64):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            total, correction = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            for chunk in range((a.shape[0]+255)//256):
                t = chunk*256+lane
                if t < a.shape[0]:
                    value = self.math.rounded(a[t]*b[t], guard)
                    total, correction = compensated_add(total, correction, value)
            shared[lane, 0] = total
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[0] = shared[0, 0]/a.shape[0]

    @ti.kernel
    def _copy_factor(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=1), row: ti.i32, lo: ti.i32):
        for t in range(out.shape[0]):
            out[t] = source[row, lo+t]

    @ti.kernel
    def _as_factor(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=2)):
        for t in range(source.shape[0]):
            out[0, t] = source[t]

    @ti.kernel
    def _copy_flow(self, source: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=1), row: ti.i32, lo: ti.i32):
        for t in range(out.shape[0]):
            out[t] = source[0, row, lo+t]

    @ti.kernel
    def _pnl_stats(self, values: ti.types.ndarray(dtype=ti.f64, ndim=1), mask: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), lo: ti.i32, hi: ti.i32, masked: ti.i32, periods: ti.f64):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256, 4), ti.f64)
            sums, corrections = ti.Vector.zero(ti.f64, 4), ti.Vector.zero(ti.f64, 4)
            for chunk in range((hi-lo+255)//256):
                t = lo+chunk*256+lane
                if t < hi:
                    if masked == 0 or mask[t] != 0:
                        value = values[t]
                        sums[0], corrections[0] = compensated_add(sums[0], corrections[0], value)
                        sums[3] = sums[3]+1.0
                        if value < 0:
                            sums[1], corrections[1] = compensated_add(sums[1], corrections[1], value*value)
                            sums[2] = sums[2]+1.0
            for k in ti.static(range(4)):
                shared[lane, k] = sums[k]
            block_tree_sum(shared, lane, 4)
            if lane == 0:
                n = shared[0, 3]
                out[0], out[1], out[2] = n, 0.0, 0.0
                if n > 0:
                    out[1] = shared[0, 0]/n*periods
                    out[2] = clipped_sortino(shared[0, 0], shared[0, 1], shared[0, 2], n, periods)
