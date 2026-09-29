"""Resident CUDA f64 feature arrays; numpy is transport/diagnostics only."""
import numpy as np
import taichi as ti

from .vm_ti import _StackProgram

_program = None


def program():
    global _program
    if _program is None:
        _program = _SeriesProgram()
    return _program


class GpuSeries:
    def __init__(self, data, dependencies=()):
        self.data = data
        self.T = data.shape[0]
        self.dependencies = dependencies
        self._prefix = None

    @classmethod
    def upload(cls, values):
        if ti.lang.impl.current_cfg().arch != ti.cuda:
            raise RuntimeError("Feature arrays require CUDA")
        values = np.asarray(values, dtype=np.float64)
        if values.ndim != 1 or not len(values):
            raise ValueError("Expected a nonempty feature column")
        data = ti.ndarray(ti.f64, shape=len(values))
        data.from_numpy(values)
        return cls(data)

    @classmethod
    def full(cls, T, value):
        data = ti.ndarray(ti.f64, shape=T)
        program()._fill(data, float(value))
        return cls(data)

    def to_numpy(self):
        ti.sync()
        return self.data.to_numpy()

    def binary(self, other, op, reverse=False):
        array = isinstance(other, GpuSeries)
        if array and self.T != other.T:
            raise ValueError("Feature column length mismatch")
        out = ti.ndarray(ti.f64, shape=self.T)
        scalar = 0.0 if array else float(other)
        mode = 0 if array else (2 if reverse else 1)
        program()._binary(self.data, other.data if array else self.data, out,
                          op, scalar, mode, 0)
        return GpuSeries(out, (self, other) if array else (self,))

    def __add__(self, other): return self.binary(other, 0)
    def __radd__(self, other): return self + other
    def __sub__(self, other): return self.binary(other, 1)
    def __rsub__(self, other): return self.binary(other, 1, True)
    def __mul__(self, other): return self.binary(other, 2)
    def __rmul__(self, other): return self * other
    def __truediv__(self, other): return self.binary(other, 3)
    def __rtruediv__(self, other): return self.binary(other, 3, True)
    def maximum(self, other): return self.binary(other, 4)
    def minimum(self, other): return self.binary(other, 5)
    def gt(self, other): return self.binary(other, 6)
    def ge(self, other): return self.binary(other, 7)
    def lt(self, other): return self.binary(other, 8)
    def le(self, other): return self.binary(other, 9)
    def eq(self, other): return self.binary(other, 10)
    def ne(self, other): return self.binary(other, 11)

    def unary(self, op, parameter=0.0):
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._unary(self.data, out, op, float(parameter), 0)
        return GpuSeries(out, (self,))

    def abs(self): return self.unary(0)
    def sign(self): return self.unary(1)
    def sqrt(self): return self.unary(2)
    def log(self): return self.unary(3)
    def sin(self): return self.unary(4)
    def cos(self): return self.unary(5)
    def isfinite(self): return self.unary(6)
    def __neg__(self): return self.unary(7)
    def exp(self): return self.unary(8)
    def power(self, exponent): return self.unary(10, exponent)

    def round(self, digits):
        if not isinstance(digits, int) or not 0 <= digits <= 12:
            raise ValueError("Unsupported decimal rounding")
        return self.unary(9, 10.0 ** digits)

    def clip(self, lower, upper):
        return self.maximum(lower).minimum(upper)

    def where(self, yes, no):
        arrays = [item for item in (yes, no) if isinstance(item, GpuSeries)]
        if any(item.T != self.T for item in arrays):
            raise ValueError("Feature column length mismatch")
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._select(self.data, yes.data if isinstance(yes, GpuSeries) else self.data,
                          no.data if isinstance(no, GpuSeries) else self.data, out,
                          0.0 if isinstance(yes, GpuSeries) else float(yes),
                          0.0 if isinstance(no, GpuSeries) else float(no),
                          int(isinstance(yes, GpuSeries)), int(isinstance(no, GpuSeries)))
        return GpuSeries(out, (self, *arrays))

    def shift(self, lag, mode):
        if not isinstance(lag, int) or lag < 0:
            raise ValueError("Invalid lag")
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._shift(self.data, out, lag, mode, 0)
        return GpuSeries(out, (self,))

    def lag(self, lag, first=False): return self.shift(lag, 1 if first else 0)
    def delta(self, lag): return self.shift(lag, 2)
    def ret(self, lag): return self.shift(lag, 3)

    def prefix(self):
        if self._prefix is None:
            self._prefix = ti.ndarray(ti.f64, shape=self.T + 1)
            program()._prefix(self.data, self._prefix, 0)
        return self._prefix

    def mean(self, window, masked=False):
        if not isinstance(window, int) or window < 1:
            raise ValueError("Invalid rolling window")
        if masked:
            good = self.isfinite()
            safe = good.where(self, 0.0)
            return good.mean(window).eq(1.0).where(safe.mean(window), float("nan"))
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._mean(self.prefix(), out, window, 0)
        return GpuSeries(out, (self,))

    def std(self, window):
        mean = self.mean(window)
        return ((self * self).mean(window) - mean * mean).maximum(0.0).sqrt()

    def zscore(self, window, masked=False, limit=5.0):
        if masked:
            good = self.isfinite()
            safe = good.where(self, 0.0)
            normalized = safe.zscore(window, limit=limit)
            return good.mean(window).eq(1.0).where(normalized, float("nan"))
        return ((self - self.mean(window)) / self.std(window).maximum(1e-8)).clip(-limit, limit)

    def window(self, window, op, other=None, offset=0):
        if not isinstance(window, int) or not 1 <= window <= 20:
            raise ValueError("Small-window reducer supports 1..20 bars")
        other = self if other is None else other
        if self.T != other.T:
            raise ValueError("Feature column length mismatch")
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._window(self.data, other.data, out, window, op, offset, 0)
        return GpuSeries(out, (self, other))

    def maximum_window(self, window): return self.window(window, 0)
    def minimum_window(self, window): return self.window(window, 1)
    def corr(self, other, window): return self.window(window, 2, other)
    def autocorr(self, window): return self.window(window, 2, offset=1)
    def moment(self, window, order):
        if order not in (3, 4):
            raise ValueError("Only skewness/kurtosis are feature moments")
        return self.window(window, order)

    def forward_fill(self, present):
        if self.T != present.T:
            raise ValueError("Feature column length mismatch")
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._forward_fill(self.data, present.data, out)
        return GpuSeries(out, (self, present))

    def streak(self):
        out = ti.ndarray(ti.f64, shape=self.T)
        program()._streak(self.data, out, 0)
        return GpuSeries(out, (self,))

    def strength(self, high, low):
        out = ti.ndarray(ti.f64, shape=self.T)
        hh, ll = high.maximum_window(14), low.minimum_window(14)
        program()._strength(self.data, hh.data, ll.data, out, 0)
        return GpuSeries(out, (self, hh, ll))

    def any_finite(self):
        count = ti.ndarray(ti.i64, shape=1)
        program()._finite_count(self.data, count)
        ti.sync()
        return int(count.to_numpy()[0]) > 0


@ti.data_oriented
class _SeriesProgram:
    def __init__(self):
        self.math = _StackProgram("f64")

    @ti.kernel
    def _fill(self, out: ti.types.ndarray(dtype=ti.f64, ndim=1), value: ti.f64):
        for t in range(out.shape[0]):
            out[t] = value

    @ti.kernel
    def _binary(self, a: ti.types.ndarray(dtype=ti.f64, ndim=1), b: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), op: ti.i32, scalar: ti.f64, mode: ti.i32, guard: ti.i64):
        for t in range(out.shape[0]):
            x, y = a[t], b[t]
            if mode == 1:
                y = scalar
            elif mode == 2:
                x, y = scalar, a[t]
            value = ti.cast(0.0, ti.f64)
            if op == 0:
                value = x + y
            elif op == 1:
                value = x - y
            elif op == 2:
                value = x * y
            elif op == 3:
                value = self.math.divide_real(x, y, guard)
            elif op == 4:
                value = y
                if x > y:
                    value = x
            elif op == 5:
                value = y
                if x < y:
                    value = x
            elif op == 6:
                value = ti.cast(x > y, ti.f64)
            elif op == 7:
                value = ti.cast(x >= y, ti.f64)
            elif op == 8:
                value = ti.cast(x < y, ti.f64)
            elif op == 9:
                value = ti.cast(x <= y, ti.f64)
            elif op == 10:
                value = ti.cast(x == y, ti.f64)
            elif op == 11:
                value = ti.cast(x != y, ti.f64)
            # CUDA fmin/fmax normally ignore a NaN operand; numpy's feature
            # operators propagate it. Preserve missingness at every operation.
            if self.math.is_nan(x) or self.math.is_nan(y):
                if op < 6:
                    value = ti.cast(float("nan"), ti.f64)
                else:
                    value = ti.cast(op == 11, ti.f64)
            out[t] = value

    @ti.kernel
    def _unary(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), op: ti.i32, parameter: ti.f64, guard: ti.i64):
        for t in range(out.shape[0]):
            x, value = source[t], ti.cast(0.0, ti.f64)
            if op == 0:
                value = ti.abs(x)
            elif op == 1:
                value = self.math.sign(x)
            elif op == 2:
                value = ti.sqrt(x)
            elif op == 3:
                value = ti.log(x)
            elif op == 4:
                value = ti.sin(x)
            elif op == 5:
                value = ti.cos(x)
            elif op == 6:
                value = ti.cast(self.math.is_finite(x), ti.f64)
            elif op == 7:
                value = -x
            elif op == 8:
                value = ti.exp(x)
            elif op == 9:
                value = x
                if self.math.is_finite(x):
                    scaled = self.math.rounded(x * parameter, guard)
                    base = ti.floor(scaled)
                    fraction = self.math.rounded(scaled - base, guard)
                    if fraction > .5 or (fraction == .5 and ti.cast(base, ti.i64) % 2 != 0):
                        base = base + 1.0
                    value = self.math.divide_real(base, parameter, guard)
                    if value == 0:
                        value = ti.bit_cast(ti.bit_cast(x, ti.u64) & ti.u64(0x8000000000000000), ti.f64)
            elif op == 10:
                value = x ** parameter
            elif op == 11:
                value = (ti.cast(x, ti.i64) - 1260) % 1440
            if op != 6 and self.math.is_nan(x):
                value = ti.cast(float("nan"), ti.f64)
            out[t] = value

    @ti.kernel
    def _select(self, condition: ti.types.ndarray(dtype=ti.f64, ndim=1), yes: ti.types.ndarray(dtype=ti.f64, ndim=1), no: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), yes_scalar: ti.f64, no_scalar: ti.f64, yes_array: ti.i32, no_array: ti.i32):
        for t in range(out.shape[0]):
            value = no_scalar
            if no_array:
                value = no[t]
            if condition[t] != 0:
                value = yes_scalar
                if yes_array:
                    value = yes[t]
            out[t] = value

    @ti.kernel
    def _shift(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), lag: ti.i32, mode: ti.i32, guard: ti.i64):
        for t in range(out.shape[0]):
            value = ti.cast(0.0, ti.f64)
            if t >= lag:
                value = source[t - lag]
                if mode == 2 or mode == 3:
                    value = self.math.rounded(source[t] - value, guard)
                    if mode == 3:
                        denominator = ti.abs(source[t - lag])
                        if denominator < 1e-9:
                            denominator = 1e-9
                        value = self.math.divide_real(value, denominator, guard)
            elif mode == 1:
                value = source[0]
            out[t] = value

    @ti.kernel
    def _prefix(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), guard: ti.i64):
        T = source.shape[0]
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256,), ti.f64)
            total = ti.cast(0.0, ti.f64)
            if lane == 0:
                out[0] = 0.0
            for chunk in range((T + 255) // 256):
                t = chunk * 256 + lane
                if t < T:
                    shared[lane] = source[t]
                ti.simt.block.sync()
                if lane == 0:
                    size = ti.min(256, T - chunk * 256)
                    for group in range(size // 8):
                        values = ti.Vector.zero(ti.f64, 8)
                        for k in ti.static(range(8)):
                            values[k] = shared[group * 8 + k]
                        for k in ti.static(range(8)):
                            total = self.math.rounded(total + values[k], guard)
                            shared[group * 8 + k] = total
                    for j in range(size - size % 8, size):
                        total = total + shared[j]
                        shared[j] = total
                ti.simt.block.sync()
                if t < T:
                    out[t + 1] = shared[lane]
                ti.simt.block.sync()

    @ti.kernel
    def _mean(self, prefix: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), window: ti.i32, guard: ti.i64):
        for t in range(out.shape[0]):
            lo = ti.max(0, t - window + 1)
            value = self.math.rounded(prefix[t + 1] - prefix[lo], guard)
            out[t] = self.math.divide(value, ti.cast(t - lo + 1, ti.f64), guard)

    @ti.func
    def _window_value(self, a: ti.template(), b: ti.template(), t, offset,
                      kind: ti.template(), mx, my, am, bm, guard):
        x, y = a[t - offset], b[t]
        value = x
        if ti.static(kind == 1):
            value = y
        elif ti.static(kind >= 2):
            dx = self.math.rounded(x - mx, guard)
            dy = self.math.rounded(y - my, guard)
            if ti.static(kind == 2):
                value = dx
            elif ti.static(kind == 3):
                value = dy
            elif ti.static(kind == 4):
                value = self.math.rounded(dx * dy, guard)
            elif ti.static(kind == 5):
                dx = self.math.rounded(dx - am, guard)
                value = self.math.rounded(dx * dx, guard)
            elif ti.static(kind == 6):
                dy = self.math.rounded(dy - bm, guard)
                value = self.math.rounded(dy * dy, guard)
            elif ti.static(kind == 7):
                value = self.math.libm.moment_power(dx, 3, guard)
            elif ti.static(kind == 8):
                value = self.math.libm.moment_power(dx, 4, guard)
        return value

    @ti.func
    def _window_sum(self, a: ti.template(), b: ti.template(), lo, n, offset,
                    kind: ti.template(), mx, my, am, bm, guard):
        # Same fixed eight-accumulator order as the CPU numpy window oracle.
        total = ti.cast(-0.0, ti.f64)
        if n < 8:
            for j in range(n):
                total = total + self._window_value(a, b, lo + j, offset, kind, mx, my, am, bm, guard)
        else:
            acc = ti.Vector.zero(ti.f64, 8)
            for k in ti.static(range(8)):
                acc[k] = self._window_value(a, b, lo + k, offset, kind, mx, my, am, bm, guard)
                if n >= 16:
                    acc[k] = acc[k] + self._window_value(a, b, lo + k + 8, offset, kind, mx, my, am, bm, guard)
            total = ((acc[0] + acc[1]) + (acc[2] + acc[3])) + ((acc[4] + acc[5]) + (acc[6] + acc[7]))
            for j in range(n - n % 8, n):
                total = total + self._window_value(a, b, lo + j, offset, kind, mx, my, am, bm, guard)
        return total

    @ti.kernel
    def _window(self, a: ti.types.ndarray(dtype=ti.f64, ndim=1), b: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), window: ti.i32, op: ti.i32, offset: ti.i32, guard: ti.i64):
        for t in range(out.shape[0]):
            value = ti.cast(0.0, ti.f64)
            if t >= offset:
                lo = ti.max(offset, t - window + 1)
                n = t - lo + 1
                count = ti.cast(n, ti.f64)
                if op <= 1:
                    value = a[lo]
                    for j in range(lo + 1, t + 1):
                        x = a[j]
                        if self.math.is_nan(x) or self.math.is_nan(value):
                            value = ti.cast(float("nan"), ti.f64)
                        elif (op == 0 and x >= value) or (op == 1 and x <= value):
                            value = x
                else:
                    mx = self.math.divide(self._window_sum(a, b, lo, n, offset, 0, 0.0, 0.0, 0.0, 0.0, guard), count, guard)
                    am = self.math.divide(self._window_sum(a, b, lo, n, offset, 2, mx, 0.0, 0.0, 0.0, guard), count, guard)
                    sx = ti.sqrt(self.math.divide(self._window_sum(a, b, lo, n, offset, 5, mx, 0.0, am, 0.0, guard), count, guard))
                    if op == 2:
                        my = self.math.divide(self._window_sum(a, b, lo, n, offset, 1, 0.0, 0.0, 0.0, 0.0, guard), count, guard)
                        bm = self.math.divide(self._window_sum(a, b, lo, n, offset, 3, 0.0, my, 0.0, 0.0, guard), count, guard)
                        sy = ti.sqrt(self.math.divide(self._window_sum(a, b, lo, n, offset, 6, 0.0, my, 0.0, bm, guard), count, guard))
                        if n >= 2 and sx >= 1e-9 and sy >= 1e-9:
                            cov = self.math.divide(self._window_sum(a, b, lo, n, offset, 4, mx, my, 0.0, 0.0, guard), count, guard)
                            value = self.math.divide_real(cov, self.math.rounded(sx * sy, guard), guard)
                    elif sx > 1e-12:
                        moment = ti.cast(0.0, ti.f64)
                        if op == 3:
                            moment = self._window_sum(a, b, lo, n, offset, 7, mx, 0.0, 0.0, 0.0, guard)
                        else:
                            moment = self._window_sum(a, b, lo, n, offset, 8, mx, 0.0, 0.0, 0.0, guard)
                        denominator = self.math.libm.moment_power(sx, 4, guard)
                        if op == 3:
                            denominator = self.math.libm.moment_power(sx, 3, guard)
                        value = self.math.divide_real(self.math.divide(moment, count, guard), denominator, guard)
            out[t] = value

    @ti.kernel
    def _forward_fill(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), present: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1)):
        for task in range(1):
            last = ti.cast(0.0, ti.f64)
            for t in range(source.shape[0]):
                if present[t] != 0:
                    last = source[t]
                out[t] = last

    @ti.kernel
    def _streak(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), guard: ti.i64):
        for task in range(1):
            run_sign, run_len = ti.cast(0.0, ti.f64), 0
            out[0] = 0.0
            for t in range(1, source.shape[0]):
                sign = self.math.sign(source[t] - source[t - 1])
                if sign == 0:
                    run_len = 0
                elif sign == run_sign:
                    run_len = run_len + 1
                else:
                    run_sign, run_len = sign, 1
                out[t] = self.math.divide(run_sign * ti.min(run_len, 12), 12.0, guard)

    @ti.kernel
    def _strength(self, close: ti.types.ndarray(dtype=ti.f64, ndim=1), high: ti.types.ndarray(dtype=ti.f64, ndim=1), low: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), guard: ti.i64):
        for task in range(1):
            prev = ti.cast(0.0, ti.f64)
            alpha = self.math.divide(1.0, 3.0, guard)
            complement = self.math.rounded(1.0 - alpha, guard)
            for t in range(close.shape[0]):
                value = ti.cast(0.0, ti.f64)
                if t >= 13:
                    price_range = self.math.rounded(high[t] - low[t], guard)
                    raw = ti.cast(50.0, ti.f64)
                    if price_range != 0:
                        raw = self.math.rounded(self.math.divide_real(self.math.rounded(close[t] - low[t], guard), price_range, guard) * 100.0, guard)
                    current = raw
                    if t > 13:
                        current = self.math.rounded(self.math.rounded(alpha * raw, guard) + self.math.rounded(complement * prev, guard), guard)
                    prev = current
                    point = self.math.divide(ti.floor(self.math.rounded(self.math.rounded(current * 100.0, guard) + .5, guard)), 100.0, guard)
                    value = self.math.rounded(self.math.divide(point, 50.0, guard) - 1.0, guard)
                out[t] = value

    @ti.kernel
    def _finite_count(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.i64, ndim=1)):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256,), ti.i64)
            total = ti.cast(0, ti.i64)
            for chunk in range((source.shape[0] + 255) // 256):
                t = chunk * 256 + lane
                if t < source.shape[0]:
                    total = total + ti.cast(self.math.is_finite(source[t]), ti.i64)
            shared[lane] = total
            ti.simt.block.sync()
            for step in ti.static((128, 64, 32, 16, 8, 4, 2, 1)):
                if lane < step:
                    shared[lane] = shared[lane] + shared[lane + step]
                ti.simt.block.sync()
            if lane == 0:
                out[0] = shared[0]
