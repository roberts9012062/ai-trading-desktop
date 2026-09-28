"""WGSL stack VM port: 256 cooperating lanes, eight slots + scratch slot.

Operator order is frozen. Every rolling read walks lo..t in ascending order;
rolling writes use scratch and a block barrier before copying back. No random,
shuffle, or floating-point atomic is used. Statistics accumulate in f64.
"""
import numpy as np
import taichi as ti

UNSUPPORTED = frozenset((38, 39, 44, 45))
BINARY = frozenset((0, 1, 2, 3, 4, 5, 29, 35, 36))
_PROGRAMS = {}


def validate_tokens(tokens, F):
    if not isinstance(tokens, (list, tuple)) or not 1 <= len(tokens) <= 32:
        raise ValueError("Candidate must contain 1..32 tokens")
    sp = 0
    for token in tokens:
        if not isinstance(token, (int, np.integer)) or token < 0:
            raise ValueError("Tokens must be non-negative integers")
        if token < 64:
            if token >= F:
                raise ValueError("Feature out of range")
            sp += 1
            if sp > 8:
                raise ValueError("Stack depth exceeds eight slots")
        else:
            op = token - 64
            if op > 50 or op in UNSUPPORTED:
                raise ValueError("Unsupported native M1 operator")
            arity = 2 if op in BINARY else 1
            if sp < arity:
                raise ValueError("Stack underflow")
            sp -= arity - 1
    if sp != 1:
        raise ValueError("Candidate must leave exactly one stack value")


class StackVM:
    def __init__(self, matrix, precision="mixed", tile=32, norm_window=250, normalization="causal_v2"):
        matrix = np.asarray(matrix)
        if matrix.ndim != 2 or not 1 <= matrix.shape[0] <= 64 or matrix.shape[1] < 2:
            raise ValueError("Invalid feature matrix")
        if precision not in ("mixed", "f64") or tile < 1 or norm_window < 1:
            raise ValueError("Invalid VM configuration")
        if ti.lang.impl.current_cfg().arch != ti.cuda:
            raise RuntimeError("M1 stack VM requires CUDA; native CPU is unavailable for evaluation")
        self.F, self.T = matrix.shape
        self.tile = tile
        self.dtype = ti.f64 if precision == "f64" else ti.f32
        self.np_dtype = np.float64 if precision == "f64" else np.float32
        self.norm_window = norm_window
        self.legacy = normalization == "legacy"
        self.cpu_rolling = precision == "f64"
        if precision not in _PROGRAMS:
            _PROGRAMS[precision] = _StackProgram(precision)
        self.program = _PROGRAMS[precision]
        self.feature_host = matrix.copy()
        self.features = ti.ndarray(self.dtype, shape=(self.F, self.T))
        self.features.from_numpy(matrix.astype(self.np_dtype))
        self.tokens = ti.ndarray(ti.i32, shape=(tile, 32))
        self.stack = ti.ndarray(self.dtype, shape=(tile, 9, self.T))
        self.factors = ti.ndarray(ti.f64, shape=(tile, self.T))
        self.prefix = ti.ndarray(ti.f64, shape=(tile, 4, self.T + 1 if self.cpu_rolling else 1))

    def upload(self, candidates):
        if len(candidates) > self.tile:
            raise ValueError("Candidate batch exceeds allocated tile")
        padded = np.full((self.tile, 32), -1, dtype=np.int32)
        for i, tokens in enumerate(candidates):
            validate_tokens(tokens, self.F)
            padded[i, :len(tokens)] = tokens
        self.tokens.from_numpy(padded)

    def dispatch(self, candidates, *, normalize=True):
        self.upload(candidates)
        self.program._execute(len(candidates), int(normalize), self.norm_window, int(self.legacy),
                              0, self.features, self.tokens, self.stack, self.factors, self.prefix)

    def execute_batch(self, candidates, *, normalize=True):
        self.dispatch(candidates, normalize=normalize)
        ti.sync()
        return self.factors.to_numpy()[:len(candidates)].copy()


@ti.data_oriented
class _StackProgram:
    """One compiled program per dtype; bar count/configuration are runtime data.

    G1 warms both programs before hello. Creating a session must not trigger a
    large LLVM compilation holding the GIL and starving the WS heartbeat.
    """
    def __init__(self, precision):
        self.dtype = ti.f64 if precision == "f64" else ti.f32
        self.cpu_rolling = precision == "f64"

    @ti.func
    def rounded(self, value, guard):
        # Scalar kernel arguments are runtime values. XOR with the always-zero
        # guard is an exact bit identity, but forces CUDA to round this f64
        # intermediate before subsequent arithmetic can contract into an FMA.
        # fast_math=False alone is insufficient in Taichi 1.7.4 CUDA codegen.
        return ti.bit_cast(ti.bit_cast(value, ti.i64) ^ guard, ti.f64)

    @ti.func
    def divide(self, numerator, denominator, guard):
        # Taichi CUDA marks the function unsafe even with fast_math=False;
        # LLVM emits reciprocal * numerator. Correct its one-ULP error using
        # an exact product residual. Here denominator is an integer window
        # length (<= norm_window), so each split product is exactly representable.
        d = self.rounded(denominator, guard)
        q = self.rounded(numerator / d, guard)
        hi = ti.bit_cast(ti.bit_cast(q, ti.i64) & ti.cast(-134217728, ti.i64), ti.f64)
        lo = self.rounded(q - hi, guard)
        residual = self.rounded(self.rounded(numerator - self.rounded(hi * d, guard), guard) - self.rounded(lo * d, guard), guard)
        return self.rounded(q + self.rounded(residual / d, guard), guard)

    @ti.func
    def divide_real(self, numerator, denominator, guard):
        d = self.rounded(denominator, guard)
        q = self.rounded(numerator / d, guard)
        value = q
        if q == q and ti.abs(q) != float("inf"):
            product = self.rounded(q * d, guard)
            qh = ti.bit_cast(ti.bit_cast(q, ti.i64) & ti.cast(-134217728, ti.i64), ti.f64)
            dh = ti.bit_cast(ti.bit_cast(d, ti.i64) & ti.cast(-134217728, ti.i64), ti.f64)
            ql, dl = self.rounded(q - qh, guard), self.rounded(d - dh, guard)
            error = self.rounded(self.rounded(qh * dh, guard) - product, guard)
            error = self.rounded(error + self.rounded(qh * dl, guard), guard)
            error = self.rounded(error + self.rounded(ql * dh, guard), guard)
            error = self.rounded(error + self.rounded(ql * dl, guard), guard)
            residual = self.rounded(self.rounded(numerator - product, guard) - error, guard)
            value = self.rounded(q + self.rounded(residual / d, guard), guard)
        return value

    @ti.func
    def log1p(self, x, guard):
        y = self.rounded(1.0 + x, guard)
        value = ti.log(y)
        if y == 1.0:
            value = x
        else:
            correction = x - self.rounded(y - 1.0, guard)
            value = value + self.divide_real(correction, y, guard)
        return value

    @ti.func
    def sign(self, x):
        out = ti.cast(0.0, self.dtype)
        if x > 0:
            out = ti.cast(1.0, self.dtype)
        elif x < 0:
            out = ti.cast(-1.0, self.dtype)
        return out

    @ti.func
    def sane(self, x):
        out = x
        if x != x:
            out = ti.cast(0.0, self.dtype)
        elif ti.abs(x) == ti.cast(float("inf"), self.dtype):
            out = self.sign(x)
        return out

    @ti.func
    def window(self, op):
        w = 20
        if op == 13:
            w = 5
        elif op == 14 or op == 16 or op == 18 or op == 20 or op == 21 or op == 42:
            w = 10
        elif op == 30 or op == 31 or op == 32 or op == 33 or op == 41 or op == 48:
            w = 60
        elif op == 49:
            w = 120
        return w

    @ti.func
    def rolling_prefix(self, p, lane, src, channel, guard, stack: ti.template(), prefix: ti.template(), shared_x: ti.template(), shared_sq: ti.template()):
        # This is a time-ordered scan (one prefix per bar), not a reduction.
        # Match the CPU rolling cumsum recurrence, including its rounding.
        # Cooperative coalesced loads/stores; lane 0 still performs every
        # addition in ascending time order. Chunking never resets the sums.
        T = stack.shape[2]
        sx, sq = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
        if lane == 0:
            prefix[p, channel, 0], prefix[p, channel + 1, 0] = 0.0, 0.0
        for chunk in range((T + 255) // 256):
            t = chunk * 256 + lane
            if t < T:
                z = ti.cast(stack[p, src, t], ti.f64)
                shared_x[lane], shared_sq[lane] = z, self.rounded(z * z, guard)
            ti.simt.block.sync()
            if lane == 0:
                size = ti.min(256, T - chunk * 256)
                for group in range(size // 8):
                    values = ti.Vector.zero(ti.f64, 8)
                    squares = ti.Vector.zero(ti.f64, 8)
                    for k in ti.static(range(8)):
                        values[k], squares[k] = shared_x[group * 8 + k], shared_sq[group * 8 + k]
                    for k in ti.static(range(8)):
                        # Preload eight inputs to overlap shared-memory reads.
                        # Add every input in the original time order, rounding
                        # each step; this is not a parallel prefix regrouping.
                        sx = self.rounded(sx + values[k], guard)
                        sq = self.rounded(sq + squares[k], guard)
                        shared_x[group * 8 + k], shared_sq[group * 8 + k] = sx, sq
                for j in range(size - size % 8, size):
                    sx = sx + shared_x[j]
                    sq = sq + shared_sq[j]
                    shared_x[j], shared_sq[j] = sx, sq
            ti.simt.block.sync()
            if t < T:
                prefix[p, channel, t + 1], prefix[p, channel + 1, t + 1] = shared_x[lane], shared_sq[lane]
            ti.simt.block.sync()
        ti.simt.block.sync()

    @ti.func
    def window_value(self, p, a, b, t, kind: ti.template(), mx, my, am, bm, guard, stack: ti.template()):
        x = ti.cast(stack[p, a, t], ti.f64)
        y = ti.cast(stack[p, b, t], ti.f64)
        value = x
        if ti.static(kind == 1):
            value = y
        elif ti.static(kind >= 2):
            dx = self.rounded(x - mx, guard)
            dy = self.rounded(y - my, guard)
            if ti.static(kind == 2):
                value = dx
            elif ti.static(kind == 3):
                value = dy
            elif ti.static(kind == 4):
                value = self.rounded(dy * dy, guard)
            elif ti.static(kind == 5):
                value = self.rounded(dx * dy, guard)
            elif ti.static(kind == 6):
                dx = self.rounded(dx - am, guard)
                value = self.rounded(dx * dx, guard)
            elif ti.static(kind == 7):
                dy = self.rounded(dy - bm, guard)
                value = self.rounded(dy * dy, guard)
        return value

    @ti.func
    def window_sum(self, p, a, b, lo, count, kind: ti.template(), mx, my, am, bm, guard, stack: ti.template()):
        # NumPy's fixed eight-accumulator small-window pairwise order.
        # https://github.com/numpy/numpy/blob/v1.26.4/numpy/core/src/umath/loops_utils.h.src
        # Read directly from the resident stack. Dynamically indexing a local
        # Vector(20) forces CUDA local-memory arrays into every VM lane, even
        # for expressions that never use a binary rolling operator.
        result = ti.cast(-0.0, ti.f64)
        if count < 8:
            for j in range(count):
                result = result + self.window_value(p, a, b, lo + j, kind, mx, my, am, bm, guard, stack)
        else:
            acc = ti.Vector.zero(ti.f64, 8)
            for k in ti.static(range(8)):
                acc[k] = self.window_value(p, a, b, lo + k, kind, mx, my, am, bm, guard, stack)
                if count >= 16:
                    acc[k] = acc[k] + self.window_value(p, a, b, lo + k + 8, kind, mx, my, am, bm, guard, stack)
            result = ((acc[0] + acc[1]) + (acc[2] + acc[3])) + ((acc[4] + acc[5]) + (acc[6] + acc[7]))
            for j in range(count - count % 8, count):
                result = result + self.window_value(p, a, b, lo + j, kind, mx, my, am, bm, guard, stack)
        return result

    @ti.func
    def authority_binary(self, p, a, b, t, op, guard, stack: ti.template(), prefix: ti.template()):
        lo = ti.max(0, t - 19)
        n = t - lo + 1
        c = ti.cast(n, ti.f64)
        mx = self.divide(self.window_sum(p, a, b, lo, n, 0, 0.0, 0.0, 0.0, 0.0, guard, stack), c, guard)
        my = self.divide(self.window_sum(p, a, b, lo, n, 1, 0.0, 0.0, 0.0, 0.0, guard, stack), c, guard)
        cov = self.divide(self.window_sum(p, a, b, lo, n, 5, mx, my, 0.0, 0.0, guard, stack), c, guard)
        value = ti.cast(0, ti.f64)
        if op == 29:
            # numpy.std centers the already centered window once more.
            am = self.divide(self.window_sum(p, a, b, lo, n, 2, mx, my, 0.0, 0.0, guard, stack), c, guard)
            bm = self.divide(self.window_sum(p, a, b, lo, n, 3, mx, my, 0.0, 0.0, guard, stack), c, guard)
            sx = ti.sqrt(self.divide(self.window_sum(p, a, b, lo, n, 6, mx, my, am, bm, guard, stack), c, guard))
            sy = ti.sqrt(self.divide(self.window_sum(p, a, b, lo, n, 7, mx, my, am, bm, guard, stack), c, guard))
            if n >= 2 and sx >= 1e-9 and sy >= 1e-9:
                value = self.divide_real(cov, self.rounded(sx * sy, guard), guard)
        else:
            vy = self.divide(self.window_sum(p, a, b, lo, n, 4, mx, my, 0.0, 0.0, guard, stack), c, guard)
            beta = ti.cast(0, ti.f64)
            if vy > 1e-12:
                beta = self.divide_real(cov, vy, guard)
            value = beta
            if op == 36:
                mx = self.divide(prefix[p, 0, t + 1] - prefix[p, 0, lo], c, guard)
                my = self.divide(prefix[p, 2, t + 1] - prefix[p, 2, lo], c, guard)
                value = (ti.cast(stack[p, a, t], ti.f64) - mx) - self.rounded(beta * (ti.cast(stack[p, b, t], ti.f64) - my), guard)
        return value

    @ti.func
    def binary(self, p, a, b, t, op, guard, stack: ti.template(), prefix: ti.template()):
        x = stack[p, a, t]
        y = stack[p, b, t]
        v = ti.cast(0.0, self.dtype)
        if op == 0:
            v = x + y
        elif op == 1:
            v = x - y
        elif op == 2:
            v = x * y
        elif op == 3:
            v = x / ti.max(ti.abs(y), ti.cast(1e-8, self.dtype)) * self.sign(y + ti.cast(1e-12, self.dtype))
            if ti.static(self.cpu_rolling):
                v = self.divide_real(x, ti.max(ti.abs(y), 1e-8), guard) * self.sign(y + 1e-12)
        elif op == 4:
            v = ti.min(x, y)
        elif op == 5:
            v = ti.max(x, y)
        else:
            lo = ti.max(0, t - 19)
            ax = ti.cast(stack[p, a, lo], ti.f64)
            ay = ti.cast(stack[p, b, lo], ti.f64)
            sx = ti.cast(0, ti.f64)
            sy = ti.cast(0, ti.f64)
            for i in range(lo, t + 1):
                sx = sx + (ti.cast(stack[p, a, i], ti.f64) - ax)
                sy = sy + (ti.cast(stack[p, b, i], ti.f64) - ay)
            c = ti.cast(t - lo + 1, ti.f64)
            mx, my = ax + sx / c, ay + sy / c
            xx, yy, xy = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
            for i in range(lo, t + 1):
                dx = ti.cast(stack[p, a, i], ti.f64) - mx
                dy = ti.cast(stack[p, b, i], ti.f64) - my
                xx = xx + dx * dx
                yy = yy + dy * dy
                xy = xy + dx * dy
            vx, vy, cov = xx / c, yy / c, xy / c
            if op == 29:
                if t - lo + 1 >= 2 and ti.sqrt(vx) >= 1e-9 and ti.sqrt(vy) >= 1e-9:
                    v = ti.cast(cov / (ti.sqrt(vx) * ti.sqrt(vy)), self.dtype)
            else:
                beta = ti.cast(0, ti.f64)
                if vy > 1e-12:
                    beta = cov / vy
                if op == 35:
                    v = ti.cast(beta, self.dtype)
                else:
                    if ti.static(self.cpu_rolling):
                        # CPU RESID uses cumsum rolling means for the final
                        # residual, separately from local means in beta.
                        mx = self.divide(prefix[p, 0, t + 1] - prefix[p, 0, lo], c, guard)
                        my = self.divide(prefix[p, 2, t + 1] - prefix[p, 2, lo], c, guard)
                        v = ti.cast((ti.cast(x, ti.f64) - mx) - self.rounded(beta * (ti.cast(y, ti.f64) - my), guard), self.dtype)
                    else:
                        v = ti.cast((ti.cast(x, ti.f64) - mx) - beta * (ti.cast(y, ti.f64) - my), self.dtype)
            if ti.static(self.cpu_rolling):
                v = self.authority_binary(p, a, b, t, op, guard, stack, prefix)
        return self.sane(v)

    @ti.func
    def unary(self, p, src, t, op, guard, stack: ti.template(), prefix: ti.template()):
        x = stack[p, src, t]
        v = ti.cast(0, self.dtype)
        if op == 6:
            v = ti.abs(x)
        elif op == 7:
            v = -x
        elif op == 8:
            v = self.sign(x)
        elif op == 9:
            v = self.sign(x) * ti.sqrt(ti.abs(x))
        elif op == 10:
            v = self.sign(x) * ti.log(ti.cast(1.0, self.dtype) + ti.abs(x))
            if ti.static(self.cpu_rolling):
                v = self.sign(x) * self.log1p(ti.abs(x), guard)
        elif op == 11:
            v = ti.cast(2.0, self.dtype) / (ti.cast(1.0, self.dtype) + ti.exp(-ti.min(ti.cast(30.0, self.dtype), ti.max(ti.cast(-30.0, self.dtype), x)))) - ti.cast(1.0, self.dtype)
            if ti.static(self.cpu_rolling):
                denominator = self.rounded(1.0 + ti.exp(-ti.min(30.0, ti.max(-30.0, x))), guard)
                v = self.divide_real(ti.cast(2.0, ti.f64), denominator, guard) - 1.0
        elif op == 12:
            v = ti.tanh(ti.min(ti.cast(30.0, self.dtype), ti.max(ti.cast(-30.0, self.dtype), x)))
        elif op == 26:
            v = ti.log(ti.cast(1.0, self.dtype) + ti.max(ti.abs(x), ti.cast(1e-9, self.dtype)))
            if ti.static(self.cpu_rolling):
                v = self.log1p(ti.max(ti.abs(x), 1e-9), guard)
        elif op == 37:
            v = ti.cast(x > 0, self.dtype)
        elif op == 24 or op == 25 or op == 50 or op == 27 or op == 28:
            n = 5
            if op == 24 or op == 27:
                n = 1
            elif op == 50:
                n = 24
            if t >= n:
                v = stack[p, src, t - n]
                if op == 24 or op == 25 or op == 50:
                    v = x - v
        else:
            w = self.window(op)
            lo = ti.max(0, t - w + 1)
            c = ti.cast(t - lo + 1, ti.f64)
            if op == 18 or op == 19 or op == 20:
                v = stack[p, src, lo]
                for i in range(lo + 1, t + 1):
                    if op == 20:
                        v = ti.min(v, stack[p, src, i])
                    else:
                        v = ti.max(v, stack[p, src, i])
            elif op == 21 or op == 22 or op == 33 or op == 40 or op == 41 or op == 42 or op == 43:
                acc = ti.cast(0, ti.f64)
                for i in range(lo, t + 1):
                    z = stack[p, src, i]
                    if op == 40 or op == 41:
                        eps = 1e-6 * ti.max(1.0, ti.abs(x))
                        if z < x - eps:
                            acc = acc + 1.0
                        elif ti.abs(z - x) <= eps:
                            acc = acc + .5
                    elif op == 42 or op == 43:
                        if ti.static(self.cpu_rolling):
                            # The non-BLAS sliding-window CPU dot materializes
                            # each product before adding it to the accumulator.
                            acc = acc + self.rounded(ti.cast(z, ti.f64) * (i - lo + 1), guard)
                        else:
                            acc = acc + ti.cast(z, ti.f64) * (i - lo + 1)
                    elif z <= x:
                        acc = acc + 1.0
                v = ti.cast(acc / c, self.dtype)
                if op == 40 or op == 41:
                    v = ti.cast(2.0 * acc / c - 1.0, self.dtype)
                elif op == 42 or op == 43:
                    v = ti.cast(acc / (c * (c + 1.0) / 2.0), self.dtype)
                if ti.static(self.cpu_rolling):
                    if op == 40 or op == 41:
                        v = self.divide(2.0 * acc, c, guard) - 1.0
                    elif op == 42 or op == 43:
                        v = self.divide(acc, c * (c + 1.0) / 2.0, guard)
                    else:
                        v = self.divide(acc, c, guard)
            else:
                s1, s2 = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
                if ti.static(self.cpu_rolling):
                    s1 = prefix[p, 0, t + 1] - prefix[p, 0, lo]
                    s2 = prefix[p, 1, t + 1] - prefix[p, 1, lo]
                else:
                    for i in range(lo, t + 1):
                        z = ti.cast(stack[p, src, i], ti.f64)
                        s1 = s1 + z
                        s2 = s2 + z * z
                m = s1 / c
                variance = s2 / c - m * m
                if ti.static(self.cpu_rolling):
                    m = self.divide(s1, c, guard)
                    variance = self.divide(s2, c, guard) - self.rounded(m * m, guard)
                sd = ti.sqrt(ti.max(variance, 0.0))
                val = m
                if op == 16 or op == 17 or op == 31:
                    val = sd
                elif op == 34:
                    val = ti.cast(x, ti.f64) - m
                elif op == 46:
                    val = ti.cast(x, ti.f64) / ti.max(sd, 1e-8)
                elif op == 47 or op == 48:
                    val = m / ti.max(sd, 1e-8)
                elif op != 13 and op != 14 and op != 15 and op != 30:
                    val = (ti.cast(x, ti.f64) - m) / ti.max(sd, 1e-8)
                if ti.static(self.cpu_rolling):
                    if op == 46:
                        val = self.divide_real(x, ti.max(sd, 1e-8), guard)
                    elif op == 47 or op == 48:
                        val = self.divide_real(m, ti.max(sd, 1e-8), guard)
                    elif op == 23 or op == 32 or op == 49:
                        val = self.divide_real(x - m, ti.max(sd, 1e-8), guard)
                v = ti.cast(val, self.dtype)
        return self.sane(v)

    @ti.kernel
    def _execute(self, count: ti.i32, normalize: ti.i32, norm_window: ti.i32, legacy: ti.i32, guard: ti.i64, features: ti.types.ndarray(ndim=2), tokens: ti.types.ndarray(dtype=ti.i32, ndim=2), stack: ti.types.ndarray(ndim=3), factors: ti.types.ndarray(dtype=ti.f64, ndim=2), prefix: ti.types.ndarray(dtype=ti.f64, ndim=3)):
        T = stack.shape[2]
        ti.loop_config(block_dim=256)
        for idx in range(count * 256):
            p, lane = idx // 256, idx % 256
            red = ti.simt.block.SharedArray((256,), ti.f64)
            # All prefix scans run sequentially inside a candidate block. Reuse
            # this storage across operator calls instead of allocating a pair
            # of arrays at every inlined call site.
            scan_x = ti.simt.block.SharedArray((256,), ti.f64)
            scan_sq = ti.simt.block.SharedArray((256,), ti.f64)
            sp = 0
            causal = legacy == 0
            for k in range(32):
                tok = tokens[p, k]
                if tok >= 0:
                    if 40 <= tok < 64 or tok >= 104:
                        causal = True
                    if tok < 64:
                        for offset in range((T + 255 - lane) // 256):
                            t = lane + offset * 256
                            stack[p, sp, t] = features[tok, t]
                        ti.simt.block.sync()
                        sp = sp + 1
                    else:
                        op = tok - 64
                        isbin = op <= 5 or op == 29 or op == 35 or op == 36
                        src = sp - 1
                        dst = src
                        rolling = op > 12 and op != 26 and op != 37
                        if isbin:
                            src = sp - 2
                            dst = src
                            rolling = op == 29 or op == 35 or op == 36
                        if rolling:
                            dst = 8
                        if ti.static(self.cpu_rolling):
                            needs_prefix = not isbin and (13 <= op <= 17 or op == 23 or 30 <= op <= 32 or op == 34 or 46 <= op <= 49)
                            if needs_prefix:
                                self.rolling_prefix(p, lane, src, 0, guard, stack, prefix, scan_x, scan_sq)
                            elif op == 36:
                                self.rolling_prefix(p, lane, sp - 2, 0, guard, stack, prefix, scan_x, scan_sq)
                                self.rolling_prefix(p, lane, sp - 1, 2, guard, stack, prefix, scan_x, scan_sq)
                        for offset in range((T + 255 - lane) // 256):
                            t = lane + offset * 256
                            v = ti.cast(0, self.dtype)
                            if isbin:
                                v = self.binary(p, sp - 2, sp - 1, t, op, guard, stack, prefix)
                            else:
                                v = self.unary(p, src, t, op, guard, stack, prefix)
                            stack[p, dst, t] = v
                        ti.simt.block.sync()
                        if rolling:
                            for offset in range((T + 255 - lane) // 256):
                                t = lane + offset * 256
                                stack[p, src, t] = stack[p, 8, t]
                            ti.simt.block.sync()
                        if isbin:
                            sp = sp - 1
            # Legacy near-constant shortcut is explicitly retained.
            total = ti.cast(0, ti.f64)
            for offset in range((T + 255 - lane) // 256):
                t = lane + offset * 256
                total = total + ti.cast(stack[p, 0, t], ti.f64)
            red[lane] = total
            ti.simt.block.sync()
            step = 128
            while step > 0:
                if lane < step:
                    red[lane] = red[lane] + red[lane + step]
                ti.simt.block.sync()
                step = step // 2
            mean = red[0] / T
            ti.simt.block.sync()
            total = ti.cast(0, ti.f64)
            for offset in range((T + 255 - lane) // 256):
                t = lane + offset * 256
                z = ti.cast(stack[p, 0, t], ti.f64) - mean
                total = total + z * z
            red[lane] = total
            ti.simt.block.sync()
            step = 128
            while step > 0:
                if lane < step:
                    red[lane] = red[lane] + red[lane + step]
                ti.simt.block.sync()
                step = step // 2
            raw_sd = ti.sqrt(red[0] / T)
            ti.simt.block.sync()
            if ti.static(self.cpu_rolling):
                if normalize != 0:
                    self.rolling_prefix(p, lane, 0, 0, guard, stack, prefix, scan_x, scan_sq)
            for offset in range((T + 255 - lane) // 256):
                t = lane + offset * 256
                val = ti.cast(stack[p, 0, t], ti.f64)
                if normalize != 0 and not (not causal and raw_sd < 1e-6):
                    lo = ti.max(0, t - norm_window + 1)
                    s1, s2 = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
                    if ti.static(self.cpu_rolling):
                        s1 = prefix[p, 0, t + 1] - prefix[p, 0, lo]
                        s2 = prefix[p, 1, t + 1] - prefix[p, 1, lo]
                    else:
                        for i in range(lo, t + 1):
                            z = ti.cast(stack[p, 0, i], ti.f64)
                            s1 = s1 + z
                            s2 = s2 + z * z
                    n = ti.cast(t - lo + 1, ti.f64)
                    m = s1 / n
                    variance = s2 / n - m * m
                    if ti.static(self.cpu_rolling):
                        m = self.divide(s1, n, guard)
                        variance = self.divide(s2, n, guard) - self.rounded(m * m, guard)
                    sd = ti.sqrt(ti.max(variance, 0.0))
                    val = ti.min(3.0, ti.max(-3.0, (val - m) / ti.max(sd, 1e-8)))
                    if ti.static(self.cpu_rolling):
                        # No subsequent rolling operator consumes this result.
                        # Preserve the rounded numerator (zero stays zero),
                        # then use deterministic CUDA f64 division. Its ULP
                        # difference is checked at the public composite gate.
                        numerator = self.rounded(ti.cast(stack[p, 0, t], ti.f64) - m, guard)
                        val = ti.min(3.0, ti.max(-3.0, numerator / ti.max(sd, 1e-8)))
                factors[p, t] = val
