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
_PHASE_PROGRAMS = {}


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
    def __init__(self, matrix, precision="mixed", tile=32, norm_window=250, normalization="causal_v2", *, compensated_coarse=True, compensated_rolling=False, shared_windows=True, bar_count=None, execution_layout="candidate_time_block", graph_dispatch=True):
        if execution_layout not in ("candidate_block", "candidate_time_block"):
            raise ValueError("Invalid VM execution layout")
        self.execution_layout = execution_layout
        self.graph_dispatch = bool(graph_dispatch)
        resident = isinstance(matrix, ti.Ndarray)
        if not resident:
            matrix = np.asarray(matrix)
        if len(matrix.shape) != 2 or not 1 <= matrix.shape[0] <= 64 or matrix.shape[1] < 2:
            raise ValueError("Invalid feature matrix")
        if resident and matrix.dtype != ti.f64:
            raise ValueError("Authoritative resident features must be f64")
        if precision not in ("mixed", "f64") or tile < 1 or norm_window < 1:
            raise ValueError("Invalid VM configuration")
        if ti.lang.impl.current_cfg().arch != ti.cuda:
            raise RuntimeError("M1 stack VM requires CUDA; native CPU is unavailable for evaluation")
        if bar_count is not None and (type(bar_count) is not int or not 2 <= bar_count <= matrix.shape[1]):
            raise ValueError('Invalid logical VM bar count')
        self.F, self.T = matrix.shape[0], matrix.shape[1] if bar_count is None else bar_count
        self.tile = tile
        self.dtype = ti.f64 if precision == "f64" else ti.f32
        self.np_dtype = np.float64 if precision == "f64" else np.float32
        self.norm_window = norm_window
        self.legacy = normalization == "legacy"
        self.cpu_rolling = precision == "f64"
        self.compensated_coarse = bool(compensated_coarse) and not self.cpu_rolling
        program_key = (precision, bool(compensated_rolling) and not self.cpu_rolling,
                       bool(shared_windows) and not self.cpu_rolling)
        if program_key not in _PROGRAMS:
            _PROGRAMS[program_key] = _StackProgram(precision, compensated_rolling=program_key[1], shared_windows=program_key[2])
        self.program = _PROGRAMS[program_key]
        self.feature_host = None if resident else matrix[:, :self.T].copy()
        if resident and precision == "f64":
            self.features = matrix
        else:
            self.features = ti.ndarray(self.dtype, shape=(self.F, self.T))
            if resident:
                _copy_features(matrix, self.features)
            else:
                self.features.from_numpy(matrix[:, :self.T].astype(self.np_dtype))
        self.tokens = ti.ndarray(ti.i32, shape=(tile, 32))
        self.stack = ti.ndarray(self.dtype, shape=(tile, 9, self.T))
        self.factors = ti.ndarray(ti.f64, shape=(tile, self.T))
        self.prefix = ti.ndarray(ti.f64, shape=(tile, 4, self.T + 1 if self.cpu_rolling else 1))
        self.coarse_terms = ti.ndarray(ti.f32, shape=(tile, 2, self.T)) if self.compensated_coarse else None
        self.phase = None
        if execution_layout == "candidate_time_block":
            from .phase_vm_ti import PhaseProgram
            if program_key not in _PHASE_PROGRAMS:
                _PHASE_PROGRAMS[program_key] = PhaseProgram(self.program)
            self.phase = _PHASE_PROGRAMS[program_key]
            self.phase_rows = ti.ndarray(ti.i32, shape=(tile, 32, 6))
            self.phase_indices = ti.ndarray(ti.i32, shape=(32, tile))
            self.phase_stats = ti.ndarray(ti.f64, shape=(tile, 2))

    def upload(self, candidates):
        if len(candidates) > self.tile:
            raise ValueError("Candidate batch exceeds allocated tile")
        padded = np.full((self.tile, 32), -1, dtype=np.int32)
        for i, tokens in enumerate(candidates):
            validate_tokens(tokens, self.F)
            padded[i, :len(tokens)] = tokens
        self.tokens.from_numpy(padded)

    def dispatch(self, candidates, *, normalize=True):
        if self.phase is not None:
            self.phase.dispatch(self, candidates, normalize=normalize)
            return
        self.upload(candidates)
        block_normalize = normalize and self.cpu_rolling
        self.program._execute(len(candidates), int(block_normalize), self.norm_window, int(self.legacy),
                              0, self.features, self.tokens, self.stack, self.factors, self.prefix)
        if normalize and not self.cpu_rolling:
            if self.compensated_coarse:
                self.program._coarse_terms(len(candidates), 0, self.stack, self.coarse_terms)
                self.program._normalize_compensated_coarse(len(candidates), self.norm_window, 0,
                    self.stack, self.factors, self.prefix, self.coarse_terms)
            else:
                self.program._normalize_coarse(len(candidates), self.norm_window, self.stack, self.factors, self.prefix)

    def execute_batch(self, candidates, *, normalize=True):
        self.dispatch(candidates, normalize=normalize)
        ti.sync()
        return self.factors.to_numpy()[:len(candidates)].copy()


@ti.kernel
def _copy_features(source: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(ndim=2)):
    for f, t in ti.ndrange(out.shape[0], out.shape[1]):
        out[f, t] = source[f, t]


@ti.data_oriented
class _StackProgram:
    """One compiled program per dtype; bar count/configuration are runtime data.

    G1 warms both programs before hello. Creating a session must not trigger a
    large LLVM compilation holding the GIL and starving the WS heartbeat.
    """
    def __init__(self, precision, *, compensated_rolling=True, shared_windows=True):
        self.dtype = ti.f64 if precision == "f64" else ti.f32
        self.cpu_rolling = precision == "f64"
        self.compensated_rolling = bool(compensated_rolling) and not self.cpu_rolling
        self.shared_windows = bool(shared_windows) and not self.cpu_rolling
        if self.cpu_rolling:
            from .libm_ti import native_libm
            self.libm = native_libm()

    @ti.func
    def rounded(self, value, guard):
        # Scalar kernel arguments are runtime values. XOR with the always-zero
        # guard is an exact bit identity, but forces CUDA to round this f64
        # intermediate before subsequent arithmetic can contract into an FMA.
        # fast_math=False alone is insufficient in Taichi 1.7.4 CUDA codegen.
        return ti.bit_cast(ti.bit_cast(value, ti.i64) ^ guard, ti.f64)

    @ti.func
    def rounded32(self, value, guard):
        return ti.bit_cast(ti.bit_cast(value, ti.i32) ^ ti.cast(guard, ti.i32), ti.f32)

    @ti.func
    def two_sum32(self, high, low, value, guard):
        total = self.rounded32(high+value, guard)
        split = self.rounded32(total-high, guard)
        error = self.rounded32(self.rounded32(high-self.rounded32(total-split, guard), guard)
                              + self.rounded32(value-split, guard), guard)
        return total, self.rounded32(low+error, guard)

    @ti.func
    def two_product32(self, a, b, guard):
        # Dekker splitting for normal, bounded f32 inputs. The caller falls
        # back for very small/large operands before relying on this expansion.
        splitter = ti.cast(4097, ti.f32)
        ca, cb = self.rounded32(splitter*a, guard), self.rounded32(splitter*b, guard)
        ah = self.rounded32(ca-self.rounded32(ca-a, guard), guard)
        bh = self.rounded32(cb-self.rounded32(cb-b, guard), guard)
        al, bl = self.rounded32(a-ah, guard), self.rounded32(b-bh, guard)
        product = self.rounded32(a*b, guard)
        error = self.rounded32(self.rounded32(ah*bh, guard)-product, guard)
        error = self.rounded32(error+self.rounded32(ah*bl, guard), guard)
        error = self.rounded32(error+self.rounded32(al*bh, guard), guard)
        error = self.rounded32(error+self.rounded32(al*bl, guard), guard)
        return product, error

    @ti.func
    def expansion_operand(self, value):
        magnitude = ti.abs(value)
        return self.is_finite(value) and (magnitude == 0 or (magnitude >= 1e-18 and magnitude <= 1e18))

    @ti.func
    def source_read(self, p, src, index, stack: ti.template(), cache: ti.template(), base, use_cache: ti.template(), channel: ti.template()):
        value = ti.cast(0, self.dtype)
        if ti.static(use_cache):
            value = cache[channel, index-base]
        else:
            value = stack[p, src, index]
        return value

    @ti.func
    def coarse_moment_value(self, x, mean, sd, op):
        value = mean
        if op == 16 or op == 17 or op == 31:
            value = sd
        elif op == 34:
            value = ti.cast(x, ti.f64)-mean
        elif op == 46:
            value = ti.cast(x, ti.f64)/ti.max(sd, 1e-8)
        elif op == 47 or op == 48:
            value = mean/ti.max(sd, 1e-8)
        elif op != 13 and op != 14 and op != 15 and op != 30:
            value = (ti.cast(x, ti.f64)-mean)/ti.max(sd, 1e-8)
        return ti.cast(value, ti.f32)

    @ti.func
    def original_coarse_moments(self, p, src, t, op, stack: ti.template(), cache: ti.template(), base, use_cache: ti.template()):
        lo = ti.max(0, t-self.window(op)+1)
        count = ti.cast(t-lo+1, ti.f64)
        s1, s2 = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
        for i in range(lo, t+1):
            z = ti.cast(self.source_read(p, src, i, stack, cache, base, use_cache, 0), ti.f64)
            s1, s2 = s1+z, s2+z*z
        mean = s1/count
        variance = s2/count-mean*mean
        value = self.coarse_moment_value(self.source_read(p, src, t, stack, cache, base, use_cache, 0), mean, ti.sqrt(ti.max(0.0, variance)), op)
        if self.is_nan(s1) or self.is_nan(s2) or self.is_nan(variance):
            value = ti.cast(0, ti.f32)
        return value

    @ti.func
    def compensated_coarse_moments(self, p, src, t, op, guard, stack: ti.template(), cache: ti.template(), base, use_cache: ti.template()):
        lo = ti.max(0, t-self.window(op)+1)
        mean_only = op == 13 or op == 14 or op == 15 or op == 30 or op == 34
        sh, sl, qh, ql = ti.cast(0, ti.f32), ti.cast(0, ti.f32), ti.cast(0, ti.f32), ti.cast(0, ti.f32)
        fallback = False
        for i in range(lo, t+1):
            z = ti.cast(self.source_read(p, src, i, stack, cache, base, use_cache, 0), ti.f32)
            fallback = fallback or not self.expansion_operand(z)
            sh, sl = self.two_sum32(sh, sl, z, guard)
            if not mean_only:
                high, low = self.two_product32(z, z, guard)
                qh, ql = self.two_sum32(qh, ql, high, guard)
                qh, ql = self.two_sum32(qh, ql, low, guard)
        count = ti.cast(t-lo+1, ti.f64)
        mean = (ti.cast(sh, ti.f64)+ti.cast(sl, ti.f64))/count
        variance = (ti.cast(qh, ti.f64)+ti.cast(ql, ti.f64))/count-mean*mean
        value = self.coarse_moment_value(self.source_read(p, src, t, stack, cache, base, use_cache, 0), mean, ti.sqrt(ti.max(0.0, variance)), op)
        if fallback:
            value = self.original_coarse_moments(p, src, t, op, stack, cache, base, use_cache)
        return value

    @ti.func
    def original_coarse_binary(self, p, a, b, t, op, stack: ti.template(), cache: ti.template(), base, use_cache: ti.template()):
        lo = ti.max(0, t-19)
        ax, ay = ti.cast(self.source_read(p, a, lo, stack, cache, base, use_cache, 0), ti.f64), ti.cast(self.source_read(p, b, lo, stack, cache, base, use_cache, 1), ti.f64)
        sx, sy = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
        for i in range(lo, t+1):
            sx = sx+(ti.cast(self.source_read(p, a, i, stack, cache, base, use_cache, 0), ti.f64)-ax)
            sy = sy+(ti.cast(self.source_read(p, b, i, stack, cache, base, use_cache, 1), ti.f64)-ay)
        count = ti.cast(t-lo+1, ti.f64)
        mx, my = ax+sx/count, ay+sy/count
        xx, yy, xy = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
        for i in range(lo, t+1):
            dx, dy = ti.cast(self.source_read(p, a, i, stack, cache, base, use_cache, 0), ti.f64)-mx, ti.cast(self.source_read(p, b, i, stack, cache, base, use_cache, 1), ti.f64)-my
            xx, yy, xy = xx+dx*dx, yy+dy*dy, xy+dx*dy
        vx, vy, cov = xx/count, yy/count, xy/count
        value = ti.cast(0, ti.f32)
        if op == 29:
            if t-lo+1 >= 2 and ti.sqrt(vx) >= 1e-9 and ti.sqrt(vy) >= 1e-9:
                value = ti.cast(cov/(ti.sqrt(vx)*ti.sqrt(vy)), ti.f32)
        else:
            beta = ti.cast(0, ti.f64)
            if vy > 1e-12:
                beta = cov/vy
            value = ti.cast(beta, ti.f32)
            if op == 36:
                value = ti.cast((ti.cast(self.source_read(p, a, t, stack, cache, base, use_cache, 0), ti.f64)-mx)
                                -beta*(ti.cast(self.source_read(p, b, t, stack, cache, base, use_cache, 1), ti.f64)-my), ti.f32)
        return value

    @ti.func
    def compensated_coarse_binary(self, p, a, b, t, op, guard, stack: ti.template(), cache: ti.template(), base, use_cache: ti.template()):
        lo = ti.max(0, t-19)
        ax, ay = ti.cast(self.source_read(p, a, lo, stack, cache, base, use_cache, 0), ti.f32), ti.cast(self.source_read(p, b, lo, stack, cache, base, use_cache, 1), ti.f32)
        sums, lows = ti.Vector.zero(ti.f32, 5), ti.Vector.zero(ti.f32, 5)
        fallback = False
        for i in range(lo, t+1):
            x, y = ti.cast(self.source_read(p, a, i, stack, cache, base, use_cache, 0), ti.f32), ti.cast(self.source_read(p, b, i, stack, cache, base, use_cache, 1), ti.f32)
            fallback = fallback or not self.expansion_operand(x) or not self.expansion_operand(y)
            sums[0], lows[0] = self.two_sum32(sums[0], lows[0], self.rounded32(x-ax, guard), guard)
            sums[1], lows[1] = self.two_sum32(sums[1], lows[1], self.rounded32(y-ay, guard), guard)
        count = ti.cast(t-lo+1, ti.f64)
        mx = ti.cast(ti.cast(ax, ti.f64)+(ti.cast(sums[0], ti.f64)+ti.cast(lows[0], ti.f64))/count, ti.f32)
        my = ti.cast(ti.cast(ay, ti.f64)+(ti.cast(sums[1], ti.f64)+ti.cast(lows[1], ti.f64))/count, ti.f32)
        for i in range(lo, t+1):
            dx = self.rounded32(ti.cast(self.source_read(p, a, i, stack, cache, base, use_cache, 0), ti.f32)-mx, guard)
            dy = self.rounded32(ti.cast(self.source_read(p, b, i, stack, cache, base, use_cache, 1), ti.f32)-my, guard)
            fallback = fallback or not self.expansion_operand(dx) or not self.expansion_operand(dy)
            for k in ti.static(range(3)):
                left, right = dx, dx
                if ti.static(k == 1):
                    left, right = dy, dy
                elif ti.static(k == 2):
                    right = dy
                high, low = self.two_product32(left, right, guard)
                sums[k+2], lows[k+2] = self.two_sum32(sums[k+2], lows[k+2], high, guard)
                sums[k+2], lows[k+2] = self.two_sum32(sums[k+2], lows[k+2], low, guard)
        vx = (ti.cast(sums[2], ti.f64)+ti.cast(lows[2], ti.f64))/count
        vy = (ti.cast(sums[3], ti.f64)+ti.cast(lows[3], ti.f64))/count
        cov = (ti.cast(sums[4], ti.f64)+ti.cast(lows[4], ti.f64))/count
        value = ti.cast(0, ti.f32)
        if op == 29:
            if t-lo+1 >= 2 and ti.sqrt(vx) >= 1e-9 and ti.sqrt(vy) >= 1e-9:
                value = ti.cast(cov/(ti.sqrt(vx)*ti.sqrt(vy)), ti.f32)
        else:
            beta = ti.cast(0, ti.f64)
            if vy > 1e-12:
                beta = cov/vy
            value = ti.cast(beta, ti.f32)
            if op == 36:
                value = ti.cast((ti.cast(self.source_read(p, a, t, stack, cache, base, use_cache, 0), ti.f64)-ti.cast(mx, ti.f64))
                                -beta*(ti.cast(self.source_read(p, b, t, stack, cache, base, use_cache, 1), ti.f64)-ti.cast(my, ti.f64)), ti.f32)
        if fallback:
            value = self.original_coarse_binary(p, a, b, t, op, stack, cache, base, use_cache)
        return value

    @ti.func
    def is_nan(self, value):
        bits = ti.bit_cast(ti.cast(value, ti.f64), ti.u64)
        return ((bits & ti.u64(0x7ff0000000000000)) == ti.u64(0x7ff0000000000000)
                and (bits & ti.u64(0x000fffffffffffff)) != 0)

    @ti.func
    def is_finite(self, value):
        bits = ti.bit_cast(ti.cast(value, ti.f64), ti.u64)
        return (bits & ti.u64(0x7ff0000000000000)) != ti.u64(0x7ff0000000000000)

    @ti.func
    def divide(self, numerator, denominator, guard):
        # Taichi CUDA marks the function unsafe even with fast_math=False;
        # LLVM emits reciprocal * numerator. Correct its one-ULP error using
        # an exact product residual. Here denominator is an integer window
        # length (<= norm_window), so each split product is exactly representable.
        d = self.rounded(denominator, guard)
        q = self.rounded(numerator / d, guard)
        value = q
        if self.is_finite(q):
            hi = ti.bit_cast(ti.bit_cast(q, ti.i64) & ti.cast(-134217728, ti.i64), ti.f64)
            lo = self.rounded(q - hi, guard)
            residual = self.rounded(self.rounded(numerator - self.rounded(hi * d, guard), guard) - self.rounded(lo * d, guard), guard)
            value = self.rounded(q + self.rounded(residual / d, guard), guard)
        return value

    @ti.func
    def divide_real(self, numerator, denominator, guard):
        d = self.rounded(denominator, guard)
        q = self.rounded(numerator / d, guard)
        value = q
        if self.is_finite(q):
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
        value = ti.cast(0.0, ti.f64)
        if ti.static(self.cpu_rolling):
            value = self.libm.log1p(x, guard)
        else:
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
        if self.is_nan(x):
            out = ti.cast(0.0, self.dtype)
        elif not self.is_finite(x):
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
    def binary(self, p, a, b, t, op, guard, stack: ti.template(), prefix: ti.template(), cache: ti.template(), base, use_cache: ti.template()):
        x = self.source_read(p, a, t, stack, cache, base, use_cache, 0)
        y = self.source_read(p, b, t, stack, cache, base, use_cache, 1)
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
        elif ti.static(self.compensated_rolling):
            v = self.compensated_coarse_binary(p, a, b, t, op, guard, stack, cache, base, use_cache)
        else:
            lo = ti.max(0, t - 19)
            ax = ti.cast(self.source_read(p, a, lo, stack, cache, base, use_cache, 0), ti.f64)
            ay = ti.cast(self.source_read(p, b, lo, stack, cache, base, use_cache, 1), ti.f64)
            sx = ti.cast(0, ti.f64)
            sy = ti.cast(0, ti.f64)
            for i in range(lo, t + 1):
                sx = sx + (ti.cast(self.source_read(p, a, i, stack, cache, base, use_cache, 0), ti.f64) - ax)
                sy = sy + (ti.cast(self.source_read(p, b, i, stack, cache, base, use_cache, 1), ti.f64) - ay)
            c = ti.cast(t - lo + 1, ti.f64)
            mx, my = ax + sx / c, ay + sy / c
            xx, yy, xy = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
            for i in range(lo, t + 1):
                dx = ti.cast(self.source_read(p, a, i, stack, cache, base, use_cache, 0), ti.f64) - mx
                dy = ti.cast(self.source_read(p, b, i, stack, cache, base, use_cache, 1), ti.f64) - my
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
        if op <= 5 and (self.is_nan(x) or self.is_nan(y)):
            v = ti.cast(0.0, self.dtype)
        return self.sane(v)

    @ti.func
    def unary(self, p, src, t, op, guard, stack: ti.template(), prefix: ti.template(), cache: ti.template(), base, use_cache: ti.template()):
        x = self.source_read(p, src, t, stack, cache, base, use_cache, 0)
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
                denominator = self.rounded(1.0 + self.libm.exp(-ti.min(30.0, ti.max(-30.0, x)), guard), guard)
                v = self.divide_real(ti.cast(2.0, ti.f64), denominator, guard) - 1.0
        elif op == 12:
            v = ti.tanh(ti.min(ti.cast(30.0, self.dtype), ti.max(ti.cast(-30.0, self.dtype), x)))
            if ti.static(self.cpu_rolling):
                v = self.libm.tanh(ti.min(30.0, ti.max(-30.0, x)), guard)
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
                v = self.source_read(p, src, t - n, stack, cache, base, use_cache, 0)
                if op == 24 or op == 25 or op == 50:
                    v = x - v
        else:
            w = self.window(op)
            lo = ti.max(0, t - w + 1)
            c = ti.cast(t - lo + 1, ti.f64)
            if op == 18 or op == 19 or op == 20:
                v = self.source_read(p, src, lo, stack, cache, base, use_cache, 0)
                missing = self.is_nan(v)
                for i in range(lo + 1, t + 1):
                    missing = missing or self.is_nan(self.source_read(p, src, i, stack, cache, base, use_cache, 0))
                    if op == 20:
                        v = ti.min(v, self.source_read(p, src, i, stack, cache, base, use_cache, 0))
                    else:
                        v = ti.max(v, self.source_read(p, src, i, stack, cache, base, use_cache, 0))
                if missing:
                    v = ti.cast(0.0, self.dtype)
            elif op == 21 or op == 22 or op == 33 or op == 40 or op == 41 or op == 42 or op == 43:
                acc = ti.cast(0, ti.f64)
                for i in range(lo, t + 1):
                    z = self.source_read(p, src, i, stack, cache, base, use_cache, 0)
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
            elif ti.static(self.compensated_rolling):
                v = self.compensated_coarse_moments(p, src, t, op, guard, stack, cache, base, use_cache)
            else:
                s1, s2 = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
                mean_only = False
                if ti.static(not self.cpu_rolling):
                    mean_only = op == 13 or op == 14 or op == 15 or op == 30 or op == 34
                if ti.static(self.cpu_rolling):
                    s1 = prefix[p, 0, t + 1] - prefix[p, 0, lo]
                    s2 = prefix[p, 1, t + 1] - prefix[p, 1, lo]
                else:
                    for i in range(lo, t + 1):
                        z = ti.cast(self.source_read(p, src, i, stack, cache, base, use_cache, 0), ti.f64)
                        s1 = s1 + z
                        if not mean_only:
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
                if self.is_nan(s1) or self.is_nan(s2) or self.is_nan(variance):
                    v = ti.cast(0.0, self.dtype)
                if ti.static(not self.cpu_rolling):
                    # A nonfinite f32 input formerly made square/cancellation
                    # NaN and returned zero, including an infinite mean.
                    if mean_only and not self.is_finite(s1):
                        v = ti.cast(0.0, self.dtype)
        if (op <= 12 or op == 26 or op == 37) and self.is_nan(x):
            v = ti.cast(0.0, self.dtype)
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
            window_cache = ti.simt.block.SharedArray((2, 376), self.dtype)
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
                        if ti.static(self.shared_windows):
                            # All lanes visit every chunk, including the final
                            # partial block. Each window still reads lo..t in
                            # its original order; only its input location changes.
                            for chunk in range((T+255)//256):
                                base = chunk*256-120
                                for offset in range((376+255-lane)//256):
                                    j = lane+offset*256
                                    index = base+j
                                    window_cache[0, j] = ti.cast(0, self.dtype)
                                    window_cache[1, j] = ti.cast(0, self.dtype)
                                    if 0 <= index < T:
                                        window_cache[0, j] = stack[p, src, index]
                                        if isbin:
                                            window_cache[1, j] = stack[p, sp-1, index]
                                ti.simt.block.sync()
                                t = chunk*256+lane
                                if t < T:
                                    v = ti.cast(0, self.dtype)
                                    if isbin:
                                        v = self.binary(p, sp-2, sp-1, t, op, guard, stack, prefix,
                                                        window_cache, base, True)
                                    else:
                                        v = self.unary(p, src, t, op, guard, stack, prefix,
                                                       window_cache, base, True)
                                    stack[p, dst, t] = v
                                ti.simt.block.sync()
                        else:
                            for offset in range((T + 255 - lane) // 256):
                                t = lane + offset * 256
                                v = ti.cast(0, self.dtype)
                                if isbin:
                                    v = self.binary(p, sp-2, sp-1, t, op, guard, stack, prefix,
                                                    window_cache, 0, False)
                                else:
                                    v = self.unary(p, src, t, op, guard, stack, prefix,
                                                   window_cache, 0, False)
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
            if ti.static(not self.cpu_rolling):
                if lane == 0:
                    prefix[p, 0, 0] = raw_sd
                    prefix[p, 1, 0] = ti.cast(causal, ti.f64)
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
                    if self.is_nan(m) or self.is_nan(variance):
                        val = ti.cast(float("nan"), ti.f64)
                factors[p, t] = val

    @ti.kernel
    def _normalize_coarse(self, count: ti.i32, norm_window: ti.i32, stack: ti.types.ndarray(dtype=ti.f32, ndim=3), factors: ti.types.ndarray(dtype=ti.f64, ndim=2), stats: ti.types.ndarray(dtype=ti.f64, ndim=3)):
        # Every bar reads the same ascending window as the original candidate
        # block. Independent bars can occupy all SMs without changing the sum
        # order, raw near-constant tree, f32 stack or f64 result semantics.
        T = factors.shape[1]
        for idx in range(count*T):
            p, t = idx//T, idx%T
            val = ti.cast(stack[p, 0, t], ti.f64)
            if not (stats[p, 1, 0] == 0 and stats[p, 0, 0] < 1e-6):
                lo = ti.max(0, t-norm_window+1)
                s1, s2 = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
                width = t-lo+1
                # Unroll independent loop bookkeeping, retaining the exact
                # ascending sequence of both accumulators and every product.
                for chunk in range(width//4):
                    for offset in ti.static(range(4)):
                        i = lo+chunk*4+offset
                        z = ti.cast(stack[p, 0, i], ti.f64)
                        s1 = s1+z
                        s2 = s2+z*z
                for i in range(lo+(width//4)*4, t+1):
                    z = ti.cast(stack[p, 0, i], ti.f64)
                    s1 = s1+z
                    s2 = s2+z*z
                n = ti.cast(t-lo+1, ti.f64)
                m = s1/n
                variance = s2/n-m*m
                sd = ti.sqrt(ti.max(variance, 0.0))
                val = ti.min(3.0, ti.max(-3.0, (val-m)/ti.max(sd, 1e-8)))
                if self.is_nan(m) or self.is_nan(variance):
                    val = ti.cast(float('nan'), ti.f64)
            factors[p, t] = val

    @ti.kernel
    def _coarse_terms(self, count: ti.i32, guard: ti.i64, stack: ti.types.ndarray(dtype=ti.f32, ndim=3), out: ti.types.ndarray(dtype=ti.f32, ndim=3)):
        # Materialize each exact f64 square once, as two f32 components. The
        # window's two-sum arithmetic then runs in f32, as permitted by §4.2.
        for p, t in ti.ndrange(count, stack.shape[2]):
            z = ti.cast(stack[p, 0, t], ti.f64)
            square = self.rounded(z*z, guard)
            high = ti.cast(square, ti.f32)
            out[p, 0, t] = high
            out[p, 1, t] = ti.cast(square-ti.cast(high, ti.f64), ti.f32)

    @ti.kernel
    def _normalize_compensated_coarse(self, count: ti.i32, norm_window: ti.i32, guard: ti.i64,
            stack: ti.types.ndarray(dtype=ti.f32, ndim=3), factors: ti.types.ndarray(dtype=ti.f64, ndim=2),
            stats: ti.types.ndarray(dtype=ti.f64, ndim=3), terms: ti.types.ndarray(dtype=ti.f32, ndim=3)):
        for p, t in ti.ndrange(count, factors.shape[1]):
            val = ti.cast(stack[p, 0, t], ti.f64)
            if not (stats[p, 1, 0] == 0 and stats[p, 0, 0] < 1e-6):
                lo = ti.max(0, t-norm_window+1)
                sh, sl, qh, ql = ti.cast(0.0, ti.f32), ti.cast(0.0, ti.f32), ti.cast(0.0, ti.f32), ti.cast(0.0, ti.f32)
                overflow = False
                for i in range(lo, t+1):
                    high, low = terms[p, 0, i], terms[p, 1, i]
                    overflow = overflow or ((ti.bit_cast(high, ti.u32) & ti.u32(0x7f800000)) == ti.u32(0x7f800000))
                    sh, sl = self.two_sum32(sh, sl, stack[p, 0, i], guard)
                    qh, ql = self.two_sum32(qh, ql, high, guard)
                    qh, ql = self.two_sum32(qh, ql, low, guard)
                s1 = ti.cast(sh, ti.f64)+ti.cast(sl, ti.f64)
                s2 = ti.cast(qh, ti.f64)+ti.cast(ql, ti.f64)
                if overflow or not self.is_finite(s1) or not self.is_finite(s2):
                    # Extreme expression magnitudes retain the original f64
                    # ascending path rather than rejecting a valid candidate.
                    s1, s2 = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
                    width = t-lo+1
                    for chunk in range(width//4):
                        for offset in ti.static(range(4)):
                            i = lo+chunk*4+offset
                            z = ti.cast(stack[p, 0, i], ti.f64)
                            s1 = s1+z
                            s2 = s2+z*z
                    for i in range(lo+(width//4)*4, t+1):
                        z = ti.cast(stack[p, 0, i], ti.f64)
                        s1 = s1+z
                        s2 = s2+z*z
                n = ti.cast(t-lo+1, ti.f64)
                m = s1/n
                variance = s2/n-m*m
                sd = ti.sqrt(ti.max(variance, 0.0))
                val = ti.min(3.0, ti.max(-3.0, (val-m)/ti.max(sd, 1e-8)))
                if self.is_nan(m) or self.is_nan(variance):
                    val = ti.cast(float('nan'), ti.f64)
            factors[p, t] = val
