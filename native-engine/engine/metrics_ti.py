"""GPU f64 training metrics; numerical payload never visits CPU numpy scoring."""
import numpy as np
import taichi as ti

from .reductions_ti import block_tree_sum, compensated_add, clipped_sortino

METRIC_NAMES = ("ann_ret", "sortino", "calmar", "ts_ic", "ts_ic_5", "ts_ic_20",
                "symmetry", "turnover_q", "oos_sortino", "oos_mult", "oos_negative",
                "consistency", "composite", "avg_turnover", "exposure", "periods", "factor_std",
                "flip_rate", "half_life")

REPORT_NAMES = ("ann_ret", "sortino", "calmar", "ts_ic", "avg_turnover", "exposure",
                "fee_total", "funding_total", "n_trades", "funding_estimated", "funding_missing")
REPORT_MODES = {"close": 0, "open": 1, "session": 2, "discrete": 3,
                "spot_long_flat": 4, "perp_next_open": 5}
_report_program = None
_training_program = None


class NumericalReports:
    """Resident full-context reporting and executable cashflow calculations."""
    def __init__(self, bars, *, tile=32):
        from datetime import datetime
        from factor_lab.scoring.funding import extract_funding_events
        self.T, self.tile = len(bars), tile
        if self.T < 3 or tile < 1:
            raise ValueError("Invalid numerical report dimensions")
        source = np.zeros((6, self.T), dtype=np.float64)
        # Raw numeric columns are transport; timestamp/event interpretation is
        # metadata. No price returns, funding cashflows or metrics run here.
        source[0] = [float(b.get("close") or 0) for b in bars]
        source[1] = [float(b.get("open") or 0) for b in bars]
        times = []
        for b in bars:
            text = str(b.get("time") or "")
            try:
                times.append(datetime.fromisoformat(text[:16]) if len(text) >= 16 else None)
            except ValueError:
                times.append(None)
        for t in range(1, self.T):
            if times[t] is not None and times[t-1] is not None:
                source[2, t] = float((times[t] - times[t-1]).total_seconds() / 60 > 150)
        events = extract_funding_events(bars)
        self.n_events = len(events)
        for event in events:
            t = event.attach_bar
            source[3, t], source[4, t] = event.rate, 1.0
            if t >= 2:
                source[5, t] = float(abs(float(bars[t-1].get("open_time") or 0) - event.settled_at_ms) < 1e-6)
        self.source = ti.ndarray(ti.f64, shape=source.shape)
        self.source.from_numpy(source)
        self._allocate(tile)

    def _allocate(self, tile):
        if type(tile) is not int or tile < 1:
            raise ValueError('Invalid report batch width')
        self.tile = tile
        self.positions = ti.ndarray(ti.f64, shape=(tile, self.T))
        self.flows = ti.ndarray(ti.f64, shape=(tile, 6, self.T))
        self.summary = ti.ndarray(ti.f64, shape=(tile, 12))
        self.means = ti.ndarray(ti.f64, shape=(tile, 2))
        self.ics = ti.ndarray(ti.f64, shape=tile)
        self.B = 1 << (((self.T + 1023) // 1024 - 1).bit_length())
        self.draw_a = ti.ndarray(ti.f64, shape=(tile, self.B, 4))
        self.draw_b = ti.ndarray(ti.f64, shape=(tile, self.B, 4))
        self.output = ti.ndarray(ti.f64, shape=(tile, len(REPORT_NAMES)))
        self.graph_dispatch = True
        self.slice_graph = None
        self.slice_outputs = None
        global _report_program
        if _report_program is None:
            _report_program = _ReportProgram()
        self.program = _report_program

    def with_tile(self, tile):
        """Reuse the frozen price/funding/calendar inputs with private outputs."""
        result = NumericalReports.__new__(NumericalReports)
        result.T, result.source, result.n_events = self.T, self.source, self.n_events
        result._allocate(tile)
        result.graph_dispatch = self.graph_dispatch
        return result

    def _cashflows(self, factors, count, lo, hi, cost, mode, entry, multiplier, *, reuse_positions=False):
        if not 1 <= count <= self.tile or factors.shape[1] != self.T:
            raise ValueError("Invalid report candidate batch")
        if mode not in REPORT_MODES or not 0 <= lo < hi <= self.T or hi-lo < 2:
            raise ValueError("Invalid report mode/slice")
        if not all(np.isfinite(x) for x in (cost, entry, multiplier)):
            raise ValueError("Nonfinite report configuration")
        mode_id = REPORT_MODES[mode]
        if reuse_positions:
            if mode_id not in (0, 1, 2):
                raise ValueError('Position reuse requires continuous slice reports')
        elif mode_id == 3:
            self.program._discrete_positions(factors, self.positions, count, entry, 0)
        else:
            self.program._positions(factors, self.positions, count, mode_id, 0)
        self.program._flows(self.source, self.positions, self.flows, count, lo, hi, cost, mode_id, multiplier, 0)
        return mode_id

    def evaluate(self, factors, count, lo, hi, cost, periods, *, mode="close", entry=.3, multiplier=1.0):
        if not np.isfinite(periods) or periods <= 0:
            raise ValueError("Invalid annualization")
        mode_id = self._cashflows(factors, count, lo, hi, cost, mode, entry, multiplier)
        return self._summarize(factors, count, lo, hi, periods, mode_id)

    def evaluate_slice_modes(self, factors, count, lo, hi, cost, periods):
        """One immutable factor/slice call; reuse identical positions and IC."""
        if not np.isfinite(periods) or periods <= 0:
            raise ValueError('Invalid annualization')
        if not 1 <= count <= self.tile or count > factors.shape[0] or factors.shape[1] != self.T:
            raise ValueError('Invalid report candidate batch')
        if not 0 <= lo < hi <= self.T or hi-lo < 2 or not np.isfinite(cost):
            raise ValueError('Invalid report slice/cost')
        if self.graph_dispatch:
            from .report_graph import ReportGraph
            if self.slice_outputs is None:
                self.slice_outputs = (self.output,
                    ti.ndarray(ti.f64, shape=(self.tile, len(REPORT_NAMES))),
                    ti.ndarray(ti.f64, shape=(self.tile, len(REPORT_NAMES))))
            if self.B not in self.program.slice_graphs:
                self.program.slice_graphs[self.B] = ReportGraph(self)
            self.slice_graph = self.program.slice_graphs[self.B]
            self.slice_graph.run(self, factors, count, lo, hi, cost, periods)
            ti.sync()
            return tuple(self._format_values(output.to_numpy()[:count], lo, hi, mode)
                         for mode, output in enumerate(self.slice_outputs))
        result = []
        for index, mode in enumerate(('close', 'open', 'session')):
            mode_id = self._cashflows(factors, count, lo, hi, cost, mode, .3, 1.,
                                      reuse_positions=index>0)
            result.append(self._summarize(factors, count, lo, hi, periods, mode_id, reuse_ic=index>0))
        return tuple(result)

    def _summarize(self, factors, count, lo, hi, periods, mode_id, *, reuse_ic=False):
        self.program._summary(self.source, self.flows, self.summary, count, lo, hi, mode_id)
        if not reuse_ic:
            self.program._means(factors, self.source, self.means, count, lo, hi, 0)
            self.program._centered(factors, self.source, self.means, self.ics, count, lo, hi, 0)
        self.program._draw_blocks(self.flows, self.draw_a, count, lo, hi, 0)
        width, a, b = self.B, self.draw_a, self.draw_b
        while width > 1:
            self.program._merge_draw(a, b, count, width // 2)
            width //= 2
            a, b = b, a
        self.program._finish(self.summary, self.ics, a, self.output, count, hi-lo, self.T, periods, mode_id)
        ti.sync()
        values = self.output.to_numpy()[:count]
        validity = self.summary.to_numpy()[:count, 11]
        return self._format_values(values, lo, hi, mode_id, validity)

    def _format_values(self, values, lo, hi, mode_id, validity=None):
        result = []
        for p, row in enumerate(values):
            if mode_id >= 4 and validity[p] > 0:
                result.append(None)
                continue
            item = dict(zip(REPORT_NAMES, map(float, row)))
            item.update(bars=float(hi-lo), n_funding_events=self.n_events if mode_id == 5 else 0,
                        no_funding_data=bool(mode_id == 5 and not self.n_events))
            result.append(item)
        return result

    def cashflows(self, factors, count, cost, *, mode, multiplier=1.0):
        """Diagnostic readback only; production reports return scalar metrics."""
        self._cashflows(factors, count, 0, self.T, cost, mode, .3, multiplier)
        ti.sync()
        values = self.flows.to_numpy()[:count]
        return {name: values[:, row].copy() for row, name in enumerate(("pnl", "held", "fee", "funding_cf"))}


@ti.data_oriented
class _ReportProgram:
    def __init__(self):
        from .vm_ti import _StackProgram
        self.math = _StackProgram("f64")
        self.slice_graphs = {}

    @ti.func
    def pos(self, value, guard):
        p = self.math.libm.tanh(ti.min(3.0, ti.max(-3.0, value)), guard)
        if ti.abs(p) < .05:
            p = 0.0
        if self.math.is_nan(value):
            p = ti.cast(float("nan"), ti.f64)
        return p

    @ti.func
    def ret(self, source: ti.template(), row, t, hi, guard):
        value = ti.cast(0.0, ti.f64)
        if t + 1 < hi:
            value = self.math.divide_real(self.math.rounded(source[row, t+1] - source[row, t], guard), ti.max(ti.abs(source[row, t]), 1e-9), guard)
        return value

    @ti.kernel
    def _positions(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, mode: ti.i32, guard: ti.i64):
        # The parallel range must be the kernel's outermost statement. A
        # runtime mode branch around this range makes Taichi execute it serially.
        for p, t in ti.ndrange(count, factors.shape[1]):
            value = self.pos(factors[p, t], guard)
            if mode == 4:
                value = ti.max(0.0, value)
            out[p, t] = value

    @ti.kernel
    def _discrete_positions(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, entry: ti.f64, guard: ti.i64):
        for p in range(count):
            state = ti.cast(0.0, ti.f64)
            # Hysteresis is a time recurrence; preserve the CPU's order while
            # independent candidates run in parallel.
            for t in range(factors.shape[1]):
                value = self.pos(factors[p, t], guard)
                if ti.abs(value) < .05:
                    state = 0.0
                elif value > entry:
                    state = 1.0
                elif value < -entry:
                    state = -1.0
                out[p, t] = state

    @ti.kernel
    def _flows(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), positions: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32, lo: ti.i32, hi: ti.i32, cost: ti.f64, mode: ti.i32, multiplier: ti.f64, guard: ti.i64):
        T = positions.shape[1]
        for p, t in ti.ndrange(count, T):
            held, fee, fund, turnover, trades, pnl = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            if mode >= 4:
                previous = ti.cast(0.0, ti.f64)
                if t >= 1:
                    held = positions[p, t-1]
                if t >= 2:
                    previous = positions[p, t-2]
                turnover = ti.abs(self.math.rounded(held - previous, guard))
                fee = self.math.rounded(turnover * cost, guard)
                price_ret = ti.cast(0.0, ti.f64)
                if t + 1 < T:
                    price_ret = self.math.divide_real(self.math.rounded(source[1, t+1] - source[1, t], guard), source[1, t], guard)
                if mode == 5 and t > 0 and source[4, t] != 0 and source[0, t-1] > 0:
                    before = ti.cast(0.0, ti.f64)
                    index = t - 2
                    if source[5, t] != 0:
                        index = t - 3
                    if index >= 0:
                        before = positions[p, index]
                    fund = self.math.rounded(self.math.rounded(-before * multiplier, guard) * source[3, t], guard)
                pnl = self.math.rounded(self.math.rounded(self.math.rounded(held * price_ret, guard) - fee, guard) + fund, guard)
            elif lo <= t and t < hi:
                held = positions[p, t]
                previous = ti.cast(0.0, ti.f64)
                if t > lo or (mode == 3 and t > 0):
                    previous = positions[p, t-1]
                turnover = ti.abs(self.math.rounded(held - previous, guard))
                ret = self.ret(source, 0, t, hi, guard)
                if mode == 1:
                    ret = self.ret(source, 1, t+1, hi, guard)
                elif mode == 2 and t > lo and source[2, t] != 0:
                    if source[1, t] > 0:
                        ret = self.math.divide_real(self.math.rounded(source[0, t] - source[1, t], guard), source[1, t], guard)
                    turnover = ti.abs(held)
                fee = self.math.rounded(turnover * cost, guard)
                pnl = self.math.rounded(self.math.rounded(held * ret, guard) - fee, guard)
                trades = ti.cast(held != 0 and held != previous, ti.f64)
            out[p, 0, t], out[p, 1, t], out[p, 2, t] = pnl, held, fee
            out[p, 3, t], out[p, 4, t], out[p, 5, t] = fund, turnover, trades

    @ti.kernel
    def _summary(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), flows: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, lo: ti.i32, hi: ti.i32, mode: ti.i32):
        T = flows.shape[2]
        ti.loop_config(block_dim=256)
        for idx in range(count * 256):
            p, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 12), ti.f64)
            total, correction = ti.Vector.zero(ti.f64, 12), ti.Vector.zero(ti.f64, 12)
            for chunk in range((T + 255) // 256):
                t = chunk * 256 + lane
                if t < T:
                    value = ti.Vector.zero(ti.f64, 12)
                    if lo <= t and t < hi:
                        pnl = flows[p, 0, t]
                        value[0] = pnl
                        if pnl < 0:
                            value[1], value[2] = pnl * pnl, 1.0
                        value[3], value[4] = flows[p, 4, t], ti.abs(flows[p, 1, t])
                        value[5], value[6], value[7] = flows[p, 2, t], flows[p, 3, t], flows[p, 5, t]
                    if mode == 5 and source[4, t] != 0:
                        if t > 0 and source[0, t-1] > 0:
                            value[8] = 1.0
                        else:
                            value[9] = 1.0
                    value[10] = flows[p, 4, t]
                    value[11] = ti.cast(source[1, t] <= 0, ti.f64)
                    for k in ti.static(range(12)):
                        if ti.static(k in (2, 7, 8, 9, 11)):
                            total[k] = total[k] + value[k]
                        else:
                            total[k], correction[k] = compensated_add(total[k], correction[k], value[k])
            for k in ti.static(range(12)):
                shared[lane, k] = total[k]
            block_tree_sum(shared, lane, 12)
            if lane == 0:
                for k in ti.static(range(12)):
                    out[p, k] = shared[0, k]

    @ti.kernel
    def _means(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), source: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, lo: ti.i32, hi: ti.i32, guard: ti.i64):
        ti.loop_config(block_dim=256)
        for idx in range(count * 256):
            p, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 2), ti.f64)
            sx, sy, cx, cy = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            n = hi - lo - 1
            for chunk in range((n + 255) // 256):
                t = lo + chunk * 256 + lane
                if t < hi - 1:
                    sx, cx = compensated_add(sx, cx, factors[p, t])
                    sy, cy = compensated_add(sy, cy, self.ret(source, 0, t, hi, guard))
            shared[lane, 0], shared[lane, 1] = sx, sy
            block_tree_sum(shared, lane, 2)
            if lane == 0:
                out[p, 0], out[p, 1] = shared[0, 0] / n, shared[0, 1] / n

    @ti.kernel
    def _centered(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), source: ti.types.ndarray(dtype=ti.f64, ndim=2), means: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=1), count: ti.i32, lo: ti.i32, hi: ti.i32, guard: ti.i64):
        ti.loop_config(block_dim=256)
        for idx in range(count * 256):
            p, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 3), ti.f64)
            total, correction = ti.Vector.zero(ti.f64, 3), ti.Vector.zero(ti.f64, 3)
            n = hi - lo - 1
            for chunk in range((n + 255) // 256):
                t = lo + chunk * 256 + lane
                if t < hi - 1:
                    x = factors[p, t] - means[p, 0]
                    y = self.ret(source, 0, t, hi, guard) - means[p, 1]
                    values = ti.Vector([x * x, y * y, x * y])
                    for k in ti.static(range(3)):
                        total[k], correction[k] = compensated_add(total[k], correction[k], values[k])
            for k in ti.static(range(3)):
                shared[lane, k] = total[k]
            block_tree_sum(shared, lane, 3)
            if lane == 0:
                value = ti.cast(0.0, ti.f64)
                sx, sy = ti.sqrt(shared[0, 0] / n), ti.sqrt(shared[0, 1] / n)
                if n >= 10 and sx >= 1e-6 and sy >= 1e-6:
                    value = shared[0, 2] / n / (sx * sy)
                out[p] = value

    @ti.kernel
    def _draw_blocks(self, flows: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32, lo: ti.i32, hi: ti.i32, guard: ti.i64):
        for p, block in ti.ndrange(count, out.shape[1]):
            cum, peak, minimum, draw = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
            for t in range(lo + block * 1024, ti.min(hi, lo + (block + 1) * 1024)):
                cum = self.math.rounded(cum + flows[p, 0, t], guard)
                peak, minimum = ti.max(peak, cum), ti.min(minimum, cum)
                draw = ti.max(draw, peak - cum)
            out[p, block, 0], out[p, block, 1] = cum, peak
            out[p, block, 2], out[p, block, 3] = minimum, draw

    @ti.kernel
    def _merge_draw(self, a: ti.types.ndarray(dtype=ti.f64, ndim=3), b: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32, width: ti.i32):
        for p, k in ti.ndrange(count, width):
            left, right = k * 2, k * 2 + 1
            b[p, k, 0] = a[p, left, 0] + a[p, right, 0]
            b[p, k, 1] = ti.max(a[p, left, 1], a[p, left, 0] + a[p, right, 1])
            b[p, k, 2] = ti.min(a[p, left, 2], a[p, left, 0] + a[p, right, 2])
            b[p, k, 3] = ti.max(ti.max(a[p, left, 3], a[p, right, 3]), a[p, left, 1] - (a[p, left, 0] + a[p, right, 2]))

    @ti.kernel
    def _finish(self, sums: ti.types.ndarray(dtype=ti.f64, ndim=2), ics: ti.types.ndarray(dtype=ti.f64, ndim=1), draw: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, n: ti.i32, T: ti.i32, periods: ti.f64, mode: ti.i32):
        for p in range(count):
            ann = sums[p, 0] / n * periods
            cal = ti.cast(0.0, ti.f64)
            if draw[p, 0, 3] < 1e-9:
                if draw[p, 0, 0] > 0:
                    cal = 10.0
            else:
                cal = ti.min(10.0, ti.max(-10.0, ann / draw[p, 0, 3]))
            turnover = sums[p, 3] / n
            if mode >= 4:
                turnover = sums[p, 10] / T
            out[p, 0], out[p, 1], out[p, 2] = ann, clipped_sortino(sums[p, 0], sums[p, 1], sums[p, 2], n, periods), cal
            out[p, 3], out[p, 4], out[p, 5] = ics[p], turnover, sums[p, 4] / n
            out[p, 6], out[p, 7], out[p, 8] = sums[p, 5], sums[p, 6], sums[p, 7]
            out[p, 9], out[p, 10] = sums[p, 8], sums[p, 9]


class TrainingMetrics:
    def __init__(self, close, cost, periods, *, tile=32, head_trim=0, shortline=False):
        close = np.asarray(close, dtype=np.float64)
        if close.ndim != 1 or len(close) - head_trim < 2 or not np.isfinite(close).all():
            raise ValueError("Invalid close series/head trim")
        if not np.isfinite(cost) or not np.isfinite(periods) or periods <= 0:
            raise ValueError("Invalid cost/annualization")
        self.T, self.head, self.N = len(close), head_trim, len(close) - head_trim
        self.cost, self.periods, self.tile = float(cost), float(periods), tile
        self.shortline = bool(shortline)
        self.close = ti.ndarray(ti.f64, shape=self.T)
        self.close.from_numpy(close)
        self.positions = ti.ndarray(ti.f64, shape=(tile, self.T))
        self.pnls = ti.ndarray(ti.f64, shape=(tile, self.N))
        self.turnovers = ti.ndarray(ti.f64, shape=(tile, self.N))
        # 22 槽:0-15 v2 冻结口径;16-21 短线 fitness 附加归约
        # (sum_pos/sum_pos2/sum_lag/flip_count/p0/pN;非 shortline 不进 composite)
        self.summary = ti.ndarray(ti.f64, shape=(tile, 22))
        self.means = ti.ndarray(ti.f64, shape=(tile, 4, 2))
        self.ics = ti.ndarray(ti.f64, shape=(tile, 4))
        self.B = 1 << (((self.N + 1023) // 1024 - 1).bit_length())
        self.draw_a = ti.ndarray(ti.f64, shape=(tile, self.B, 4))
        self.draw_b = ti.ndarray(ti.f64, shape=(tile, self.B, 4))
        self.output = ti.ndarray(ti.f64, shape=(tile, len(METRIC_NAMES)))
        global _training_program
        if _training_program is None:
            _training_program = _TrainingProgram()
        self.program = _training_program
        self.returns = ti.ndarray(ti.f64, shape=(4, self.T))
        self.program._returns(self.close, self.returns, 0)

    def evaluate(self, factors, count, *, ranking_only=False, coarse_positions=False):
        if not 0 <= count <= self.tile:
            raise ValueError("Metric batch exceeds allocated tile")
        if coarse_positions and not ranking_only:
            raise ValueError('f32 positions are restricted to private ranking')
        if coarse_positions:
            self.program._coarse_positions(factors, self.positions, count)
        else:
            self.program._positions(factors, self.positions, count, 0)
        self.program._pnl_cache(self.positions, self.returns, self.pnls, self.turnovers, count, self.head, self.cost, 0)
        self.program._summary(self.positions, self.pnls, self.turnovers, self.summary, count, self.head)
        # IC5/20 are report-only fields. The private coarse path needs the
        # factor standard deviation and IC1; public authority still computes all.
        groups = 2 if ranking_only else 4
        if ranking_only:
            self.ics.fill(0)
        self.program._means(factors, self.returns, self.means, count, self.head, groups)
        self.program._centered(factors, self.returns, self.means, self.ics, count, self.head, groups)
        self.program._draw_blocks(self.pnls, self.draw_a, count)
        width, a, b = self.B, self.draw_a, self.draw_b
        while width > 1:
            self.program._merge_draw(a, b, count, width // 2)
            width //= 2
            a, b = b, a
        self.program._finish(self.summary, self.ics, a, self.output, count, self.N, self.periods,
                             1 if self.shortline else 0)
        ti.sync()
        return self.output.to_numpy()[:count].copy()


@ti.data_oriented
class _TrainingProgram:
    """Shared G1-warmed kernels; session configuration is runtime data."""
    def __init__(self):
        from .vm_ti import _StackProgram
        self.math = _StackProgram('f64')

    @ti.func
    def pos(self, value, guard):
        # A one-ULP position change on a flat-price plateau can turn zero
        # cashflow into a negative fee and change the Sortino sample count.
        p = self.math.libm.tanh(ti.min(3.0, ti.max(-3.0, value)), guard)
        if ti.abs(p) < .05:
            p = 0.0
        return p

    @ti.func
    def ret(self, close: ti.template(), t, h, guard):
        out = ti.cast(0, ti.f64)
        if t + h < close.shape[0]:
            delta = self.math.rounded(close[t + h] - close[t], guard)
            out = self.math.divide_real(delta, ti.max(ti.abs(close[t]), 1e-9), guard)
            if out == 0:
                out = ti.bit_cast(ti.bit_cast(delta, ti.i64) & ti.i64(-9223372036854775808), ti.f64)
        return out

    @ti.kernel
    def _returns(self, close: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=2), guard: ti.i64):
        # Price-only frozen input, retaining each CPU f64 operation's rounding
        # and the terminal zero return for every horizon.
        for group, t in ti.ndrange(4, close.shape[0]):
            out[group, t] = self.ret(close, t, self.horizon(group), guard)

    @ti.kernel
    def _positions(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), positions: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, guard: ti.i64):
        T = factors.shape[1]
        for idx in range(count * T):
            p, t = idx // T, idx % T
            positions[p, t] = self.pos(factors[p, t], guard)

    @ti.kernel
    def _coarse_positions(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), positions: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32):
        # Only private coarse scores consume this f32 expression. All following
        # statistics retain the original fixed f64 compensated reductions.
        for p, t in ti.ndrange(count, factors.shape[1]):
            value = ti.cast(factors[p, t], ti.f32)
            position = ti.tanh(ti.min(ti.cast(3, ti.f32), ti.max(ti.cast(-3, ti.f32), value)))
            if ti.abs(position) < ti.cast(.05, ti.f32):
                position = ti.cast(0, ti.f32)
            positions[p, t] = ti.cast(position, ti.f64)

    @ti.kernel
    def _pnl_cache(self, positions: ti.types.ndarray(dtype=ti.f64, ndim=2), returns: ti.types.ndarray(dtype=ti.f64, ndim=2), pnls: ti.types.ndarray(dtype=ti.f64, ndim=2), turnovers: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, head: ti.i32, cost: ti.f64, guard: ti.i64):
        N = pnls.shape[1]
        for idx in range(count * N):
            p, j = idx // N, idx % N
            t = head + j
            pos, prev = positions[p, t], ti.cast(0, ti.f64)
            if j > 0:
                prev = positions[p, t - 1]
            turnover = ti.abs(self.math.rounded(pos - prev, guard))
            price_pnl = self.math.rounded(pos * returns[1, t], guard)
            fee = self.math.rounded(turnover * cost, guard)
            pnls[p, j] = self.math.rounded(price_pnl - fee, guard)
            turnovers[p, j] = turnover

    @ti.kernel
    def _summary(self, positions: ti.types.ndarray(dtype=ti.f64, ndim=2), pnls: ti.types.ndarray(dtype=ti.f64, ndim=2), turnovers: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, head: ti.i32):
        N = pnls.shape[1]
        ti.loop_config(block_dim=256)
        for idx in range(count * 256):
            p, lane = idx // 256, idx % 256
            shared = ti.simt.block.SharedArray((256, 22), ti.f64)
            acc = ti.Vector.zero(ti.f64, 22)
            correction = ti.Vector.zero(ti.f64, 22)
            for offset in range((N + 255 - lane) // 256):
                j = lane + offset * 256
                pnl, turnover, pos = pnls[p, j], turnovers[p, j], positions[p, head + j]
                dn2, ndn = ti.cast(0, ti.f64), ti.cast(0, ti.f64)
                if pnl < 0:
                    dn2, ndn = pnl * pnl, 1.0
                value = ti.Vector.zero(ti.f64, 22)
                value[0], value[1], value[2] = pnl, dn2, ndn
                value[3], value[4] = turnover, ti.abs(pos)
                value[5], value[6] = ti.cast(pos > 0, ti.f64), ti.cast(pos < 0, ti.f64)
                if j >= N - ti.max(1, N // 4):
                    value[7], value[8], value[9] = pnl, dn2, ndn
                if j < N // 2:
                    value[10], value[11], value[12] = pnl, dn2, ndn
                else:
                    value[13], value[14], value[15] = pnl, dn2, ndn
                # 16-21: 短线 fitness 归约(冻结口径与 pykernel evaluate.py 对齐)
                prev = positions[p, head + j - 1] if j >= 1 else 0.0
                value[16], value[17] = pos, pos * pos
                if j >= 1:
                    value[18] = pos * prev
                    if pos * prev < 0:
                        value[19] = 1.0
                if j == 0:
                    value[20] = pos
                if j == N - 1:
                    value[21] = pos
                for k in ti.static(range(22)):
                    if ti.static(k in (2, 5, 6, 9, 12, 15, 19, 20, 21)):
                        # Counts are exact integers <= 300k, representable in
                        # f64; compensation cannot improve these additions.
                        acc[k] = acc[k] + value[k]
                    else:
                        acc[k], correction[k] = compensated_add(acc[k], correction[k], value[k])
            for k in ti.static(range(22)):
                shared[lane, k] = acc[k]
            block_tree_sum(shared, lane, 22)
            if lane == 0:
                for k in ti.static(range(22)):
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
    def _means(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), returns: ti.types.ndarray(dtype=ti.f64, ndim=2), means: ti.types.ndarray(dtype=ti.f64, ndim=3), count: ti.i32, head: ti.i32, groups: ti.i32):
        N = returns.shape[1] - head
        ti.loop_config(block_dim=256)
        for idx in range(count * groups * 256):
            p, group, lane = idx // (groups*256), (idx // 256) % groups, idx % 256
            shared = ti.simt.block.SharedArray((256, 2), ti.f64)
            h = self.horizon(group)
            n = ti.max(0, N - h)
            sx, sy, cx, cy = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
            for offset in range(ti.max(0, (n + 255 - lane) // 256)):
                t = head + lane + offset * 256
                x = factors[p, t]
                y = returns[group, t]
                sx, cx = compensated_add(sx, cx, x)
                sy, cy = compensated_add(sy, cy, y)
            shared[lane, 0], shared[lane, 1] = sx, sy
            block_tree_sum(shared, lane, 2)
            if lane == 0:
                means[p, group, 0] = shared[0, 0] / ti.max(1, n)
                means[p, group, 1] = shared[0, 1] / ti.max(1, n)

    @ti.kernel
    def _centered(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), returns: ti.types.ndarray(dtype=ti.f64, ndim=2), means: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, head: ti.i32, groups: ti.i32):
        N = returns.shape[1] - head
        ti.loop_config(block_dim=256)
        for idx in range(count * groups * 256):
            p, group, lane = idx // (groups*256), (idx // 256) % groups, idx % 256
            shared = ti.simt.block.SharedArray((256, 3), ti.f64)
            n = ti.max(0, N - self.horizon(group))
            acc, correction = ti.Vector.zero(ti.f64, 3), ti.Vector.zero(ti.f64, 3)
            for offset in range(ti.max(0, (n + 255 - lane) // 256)):
                t = head + lane + offset * 256
                x = factors[p, t] - means[p, group, 0]
                y = returns[group, t] - means[p, group, 1]
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
        N, B = pnls.shape[1], out.shape[1]
        for idx in range(count * B):
            p, block = idx // B, idx % B
            cum, peak, minimum, draw = ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64), ti.cast(0, ti.f64)
            # Prefix recurrence is fixed in time; summaries merge in a fixed tree.
            for j in range(block * 1024, ti.min(N, (block + 1) * 1024)):
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
    def _finish(self, sums: ti.types.ndarray(dtype=ti.f64, ndim=2), ics: ti.types.ndarray(dtype=ti.f64, ndim=2), draw: ti.types.ndarray(dtype=ti.f64, ndim=3), out: ti.types.ndarray(dtype=ti.f64, ndim=2), count: ti.i32, N: ti.i32, periods: ti.f64, shortline: ti.i32):
        for p in range(count):
            ann = sums[p, 0] / N * periods
            sor = clipped_sortino(sums[p, 0], sums[p, 1], sums[p, 2], N, periods)
            cal = ti.cast(0, ti.f64)
            if draw[p, 0, 3] < 1e-9:
                if draw[p, 0, 0] > 0:
                    cal = 10.0
            else:
                cal = ti.min(10.0, ti.max(-10.0, ann / draw[p, 0, 3]))
            sym = ti.max(-1.0, 1.0 - 2.0 * (ti.abs(sums[p, 5] / N - .5) + ti.abs(sums[p, 6] / N - .5)))
            turnover = sums[p, 3] / N
            tq = ti.cast(0, ti.f64)
            if turnover < 1e-6:
                tq = -1.0
            elif turnover > 1.0:
                tq = ti.max(-1.0, -(turnover - 1.0))
            oos = clipped_sortino(sums[p, 7], sums[p, 8], sums[p, 9], ti.max(1, N // 4), periods)
            s1 = clipped_sortino(sums[p, 10], sums[p, 11], sums[p, 12], N // 2, periods)
            s2 = clipped_sortino(sums[p, 13], sums[p, 14], sums[p, 15], N - N // 2, periods)
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
            # 短线 fitness(shortline_v1):翻转率/半衰期惩罚乘子(冻结系数,
            # 与 pykernel scoring/evaluate.shortline_penalty 同式)
            m = sums[p, 16] / N
            c0 = sums[p, 17] / N - m * m
            denom = ti.max(N - 1, 1)
            sa = sums[p, 16] - sums[p, 20]
            sb = sums[p, 16] - sums[p, 21]
            c1 = (sums[p, 18] - m * (sa + sb) + (N - 1) * m * m) / denom
            flip_rate = sums[p, 19] / denom
            rho = c1 / ti.max(c0, 1e-12)
            # 只认正持久性:rho<=0(交替翻转)→ a 下限 → hl 最快衰减
            a = ti.min(ti.max(rho, 1e-9), 0.9999999)
            half_life = ti.min(ti.log(2.0) / (-ti.log(a)), 500.0)
            if shortline != 0:
                penalty = 1.0
                penalty = penalty - 0.5 * ti.min(turnover / 0.35, 1.0)
                penalty = penalty - 0.3 * ti.min(flip_rate / 0.08, 1.0)
                penalty = penalty - 0.2 * ti.max(0.0, 1.0 - half_life / 48.0)
                comp = comp * ti.max(penalty, 0.0)
            out[p, 12], out[p, 13], out[p, 14] = comp, turnover, sums[p, 4] / N
            out[p, 15], out[p, 16] = periods, ics[p, 0]
            out[p, 17], out[p, 18] = flip_rate, half_life
