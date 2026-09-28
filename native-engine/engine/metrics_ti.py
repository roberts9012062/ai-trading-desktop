"""GPU f64 training metrics; numerical payload never visits CPU numpy scoring."""
import numpy as np
import taichi as ti

from .reductions_ti import block_tree_sum, compensated_add, clipped_sortino

METRIC_NAMES = ("ann_ret", "sortino", "calmar", "ts_ic", "ts_ic_5", "ts_ic_20",
                "symmetry", "turnover_q", "oos_sortino", "oos_mult", "oos_negative",
                "consistency", "composite", "avg_turnover", "exposure", "periods", "factor_std")


@ti.data_oriented
class TrainingMetrics:
    def __init__(self, close, cost, periods, *, tile=32, head_trim=0):
        close = np.asarray(close, dtype=np.float64)
        if close.ndim != 1 or len(close) - head_trim < 2 or not np.isfinite(close).all():
            raise ValueError("Invalid close series/head trim")
        if not np.isfinite(cost) or not np.isfinite(periods) or periods <= 0:
            raise ValueError("Invalid cost/annualization")
        self.T, self.head, self.N = len(close), head_trim, len(close) - head_trim
        self.cost, self.periods, self.tile = float(cost), float(periods), tile
        self.close = ti.ndarray(ti.f64, shape=self.T)
        self.close.from_numpy(close)
        self.positions = ti.ndarray(ti.f64, shape=(tile, self.T))
        self.pnls = ti.ndarray(ti.f64, shape=(tile, self.N))
        self.turnovers = ti.ndarray(ti.f64, shape=(tile, self.N))
        self.summary = ti.ndarray(ti.f64, shape=(tile, 16))
        self.means = ti.ndarray(ti.f64, shape=(tile, 4, 2))
        self.ics = ti.ndarray(ti.f64, shape=(tile, 4))
        self.B = 1 << (((self.N + 1023) // 1024 - 1).bit_length())
        self.draw_a = ti.ndarray(ti.f64, shape=(tile, self.B, 4))
        self.draw_b = ti.ndarray(ti.f64, shape=(tile, self.B, 4))
        self.output = ti.ndarray(ti.f64, shape=(tile, len(METRIC_NAMES)))

    def evaluate(self, factors, count):
        if not 0 <= count <= self.tile:
            raise ValueError("Metric batch exceeds allocated tile")
        self._positions(factors, self.positions, count)
        self._pnl_cache(self.positions, self.close, self.pnls, self.turnovers, count)
        self._summary(self.positions, self.pnls, self.turnovers, self.summary, count)
        self._means(factors, self.close, self.means, count)
        self._centered(factors, self.close, self.means, self.ics, count)
        self._draw_blocks(self.pnls, self.draw_a, count)
        width, a, b = self.B, self.draw_a, self.draw_b
        while width > 1:
            self._merge_draw(a, b, count, width // 2)
            width //= 2
            a, b = b, a
        self._finish(self.summary, self.ics, a, self.output, count)
        ti.sync()
        return self.output.to_numpy()[:count].copy()

    @ti.func
    def pos(self, value):
        p = ti.tanh(ti.min(3.0, ti.max(-3.0, value)))
        if ti.abs(p) < .05:
            p = 0.0
        return p

    @ti.func
    def ret(self, close: ti.template(), t, h):
        out = ti.cast(0, ti.f64)
        if t + h < self.T:
            out = (close[t + h] - close[t]) / ti.max(ti.abs(close[t]), 1e-9)
        return out

    @ti.kernel
    def _positions(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), positions: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32):
        for idx in range(count * self.T):
            p, t = idx // self.T, idx % self.T
            positions[p, t] = self.pos(factors[p, t])

    @ti.kernel
    def _pnl_cache(self, positions: ti.types.ndarray(dtype=ti.f64, ndim=2), close: ti.types.ndarray(dtype=ti.f64, ndim=1), pnls: ti.types.ndarray(dtype=ti.f64, ndim=2), turnovers: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32):
        for idx in range(count * self.N):
            p, j = idx // self.N, idx % self.N
            t = self.head + j
            pos, prev = positions[p, t], ti.cast(0, ti.f64)
            if j > 0:
                prev = positions[p, t - 1]
            turnover = ti.abs(pos - prev)
            pnls[p, j] = pos * self.ret(close, t, 1) - turnover * self.cost
            turnovers[p, j] = turnover

    @ti.kernel
    def _summary(self, positions: ti.types.ndarray(dtype=ti.f64, ndim=2), pnls: ti.types.ndarray(dtype=ti.f64, ndim=2), turnovers: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(count * 256):
            p, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 16), ti.f64)
            acc = ti.Vector.zero(ti.f64, 16)
            correction = ti.Vector.zero(ti.f64, 16)
            for offset in range((self.N + 255 - lane) // 256):
                j = lane + offset * 256
                pnl, turnover, pos = pnls[p, j], turnovers[p, j], positions[p, self.head + j]
                dn2, ndn = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
                if pnl < 0:
                    dn2, ndn = pnl * pnl, 1.0
                value = ti.Vector.zero(ti.f64, 16)
                value[0], value[1], value[2] = pnl, dn2, ndn
                value[3], value[4] = turnover, ti.abs(pos)
                value[5], value[6] = ti.cast(pos > 0, ti.f64), ti.cast(pos < 0, ti.f64)
                if j >= self.N - ti.max(1, self.N // 4):
                    value[7], value[8], value[9] = pnl, dn2, ndn
                if j < self.N // 2:
                    value[10], value[11], value[12] = pnl, dn2, ndn
                else:
                    value[13], value[14], value[15] = pnl, dn2, ndn
                for k in ti.static(range(16)):
                    if ti.static(k in (2, 5, 6, 9, 12, 15)):
                        # Counts are exact integers <= 300k, representable in
                        # f64; compensation cannot improve these additions.
                        acc[k] = acc[k] + value[k]
                    else:
                        acc[k], correction[k] = compensated_add(acc[k], correction[k], value[k])
            for k in ti.static(range(16)):
                shared[lane, k] = acc[k]
            block_tree_sum(shared, lane, 16)
            if lane == 0:
                for k in ti.static(range(16)):
                    out[p, k] = shared[0, k]

    @ti.func
    def horizon(self, group):
        h = 0
        if group == 1:
            h = 1
        elif group == 2:
            h = 5
        elif group == 3:
            h = 20
        return h

    @ti.kernel
    def _means(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), close: ti.types.ndarray(dtype=ti.f64, ndim=1), means: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(count * 4 * 256):
            p, group, lane = idx // 1024, (idx // 256) % 4, idx % 256
            shared = ti.simt.block.SharedArray((256, 2), ti.f64)
            h = self.horizon(group)
            n = ti.max(0, self.N - h)
            sx, sy, cx, cy = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
            for offset in range(ti.max(0, (n + 255 - lane) // 256)):
                t = self.head + lane + offset * 256
                x = factors[p, t]
                y = self.ret(close, t, h)
                sx, cx = compensated_add(sx, cx, x)
                sy, cy = compensated_add(sy, cy, y)
            shared[lane, 0], shared[lane, 1] = sx, sy
            block_tree_sum(shared, lane, 2)
            if lane == 0:
                means[p, group, 0] = shared[0, 0] / ti.max(1, n)
                means[p, group, 1] = shared[0, 1] / ti.max(1, n)

    @ti.kernel
    def _centered(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), close: ti.types.ndarray(dtype=ti.f64, ndim=1), means: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(count * 4 * 256):
            p, group, lane = idx // 1024, (idx // 256) % 4, idx % 256
            shared = ti.simt.block.SharedArray((256, 3), ti.f64)
            n = ti.max(0, self.N - self.horizon(group))
            acc, correction = ti.Vector.zero(ti.f64, 3), ti.Vector.zero(ti.f64, 3)
            for offset in range(ti.max(0, (n + 255 - lane) // 256)):
                t = self.head + lane + offset * 256
                x = factors[p, t] - means[p, group, 0]
                y = self.ret(close, t, self.horizon(group)) - means[p, group, 1]
                value = ti.Vector([x * x, y * y, x * y])
                for k in ti.static(range(3)):
                    acc[k], correction[k] = compensated_add(acc[k], correction[k], value[k])
            for k in ti.static(range(3)):
                shared[lane, k] = acc[k]
            block_tree_sum(shared, lane, 3)
            if lane == 0:
                result = ti.cast(0, ti.f64)
                sx = ti.sqrt(shared[0, 0] / ti.max(n, 1))
                sy = ti.sqrt(shared[0, 1] / ti.max(n, 1))
                if group == 0:
                    result = sx
                elif n >= 10 and sx >= 1e-6 and sy >= 1e-6:
                    result = shared[0, 2] / n / (sx * sy)
                out[p, group] = result

    @ti.kernel
    def _draw_blocks(self, pnls: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32):
        for idx in range(count * self.B):
            p, block = idx // self.B, idx % self.B
            cum, peak, minimum, draw = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
            # Prefix recurrence is fixed in time; summaries merge in a fixed tree.
            for j in range(block * 1024, ti.min(self.N, (block + 1) * 1024)):
                pnl = pnls[p, j]
                cum = cum + pnl
                peak = ti.max(peak, cum)
                minimum = ti.min(minimum, cum)
                draw = ti.max(draw, peak - cum)
            out[p, block, 0], out[p, block, 1] = cum, peak
            out[p, block, 2], out[p, block, 3] = minimum, draw

    @ti.kernel
    def _merge_draw(self, a: ti.types.ndarray(dtype=ti.f64, ndim=3), b: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32, width: ti.i32):
        for idx in range(count * width):
            p, k = idx // width, idx % width
            left, right = k * 2, k * 2 + 1
            b[p, k, 0] = a[p, left, 0] + a[p, right, 0]
            b[p, k, 1] = ti.max(a[p, left, 1], a[p, left, 0] + a[p, right, 1])
            b[p, k, 2] = ti.min(a[p, left, 2], a[p, left, 0] + a[p, right, 2])
            b[p, k, 3] = ti.max(ti.max(a[p, left, 3], a[p, right, 3]), a[p, left, 1] - (a[p, left, 0] + a[p, right, 2]))

    @ti.kernel
    def _finish(self, sums: ti.types.ndarray(dtype=ti.f64, ndim=2), ics: ti.types.ndarray(dtype=ti.f64, ndim=2), draw: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32):
        for p in range(count):
            ann = sums[p, 0] / self.N * self.periods
            sor = clipped_sortino(sums[p, 0], sums[p, 1], sums[p, 2], self.N, self.periods)
            cal = ti.cast(0, ti.f64)
            if draw[p, 0, 3] < 1e-9:
                if draw[p, 0, 0] > 0:
                    cal = 10.0
            else:
                cal = ti.min(10.0, ti.max(-10.0, ann / draw[p, 0, 3]))
            sym = ti.max(-1.0, 1.0 - 2.0 * (ti.abs(sums[p, 5] / self.N - .5) + ti.abs(sums[p, 6] / self.N - .5)))
            turnover = sums[p, 3] / self.N
            tq = ti.cast(0, ti.f64)
            if turnover < 1e-6:
                tq = -1.0
            elif turnover > 1.0:
                tq = ti.max(-1.0, -(turnover - 1.0))
            oos = clipped_sortino(sums[p, 7], sums[p, 8], sums[p, 9], ti.max(1, self.N // 4), self.periods)
            s1 = clipped_sortino(sums[p, 10], sums[p, 11], sums[p, 12], self.N // 2, self.periods)
            s2 = clipped_sortino(sums[p, 13], sums[p, 14], sums[p, 15], self.N - self.N // 2, self.periods)
            consist = ti.cast(0, ti.f64)
            if s1 > 0 and s2 > 0:
                consist = .5
            elif s1 * s2 < 0:
                consist = -1.0
            mult = ti.cast(0, ti.f64)
            if oos > 0:
                mult = ti.min(1.2, 1.0 + oos * .1)
            comp = (.30 * ti.min(1.0, ti.max(-1.0, ann)) + .15 * sor + .10 * cal + .20 * ics[p, 1] + .05 * sym + .05 * tq + .10 * consist) * mult
            out[p, 0], out[p, 1], out[p, 2] = ann, sor, cal
            out[p, 3], out[p, 4], out[p, 5] = ics[p, 1], ics[p, 2], ics[p, 3]
            out[p, 6], out[p, 7], out[p, 8] = sym, tq, oos
            out[p, 9], out[p, 10], out[p, 11] = mult, ti.cast(oos <= 0, ti.f64), consist
            out[p, 12], out[p, 13], out[p, 14] = comp, turnover, sums[p, 4] / self.N
            out[p, 15], out[p, 16] = self.periods, ics[p, 0]
