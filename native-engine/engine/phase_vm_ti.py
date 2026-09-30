"""Instruction boundaries replace candidate barriers; arithmetic is unchanged.

Host decoding produces stack indices only. Every expression value, ordered
window, prefix scan, raw statistic and normalized output stays on CUDA.
"""
import numpy as np
import taichi as ti

from .vm_ti import BINARY, validate_tokens


def decode_instruction_rows(candidates, feature_count):
    """Encode token, source_a, source_b, destination, rolling, active."""
    rows = np.zeros((len(candidates), 32, 6), dtype=np.int32)
    for p, tokens in enumerate(candidates):
        validate_tokens(tokens, feature_count)
        sp = 0
        for k, token in enumerate(tokens):
            if token < 64 or token >= 115:
                # token 原值入行(115-122 的行映射在 kernel 侧完成)
                rows[p, k] = token, sp, sp, sp, 0, 1
                sp += 1
            else:
                op = token-64
                binary = op in BINARY
                src = sp-(2 if binary else 1)
                other = sp-1
                rolling = op in (29, 35, 36) if binary else op > 12 and op not in (26, 37)
                rows[p, k] = token, src, other, 8 if rolling else src, int(rolling), 1
                sp -= int(binary)
    return rows


def active_row_indices(rows, tile):
    """Pack original candidate ids per instruction; no numerical data read."""
    if len(rows) > tile:
        raise ValueError('Instruction rows exceed the allocated tile')
    indices = np.zeros((32, tile), dtype=np.int32)
    counts = []
    for step in range(32):
        selected = np.flatnonzero(rows[:, step, 5])
        indices[step, :len(selected)] = selected
        counts.append(len(selected))
    return indices, counts


@ti.data_oriented
class PhaseProgram:
    def __init__(self, program):
        self.math = program
        self.dtype = program.dtype
        self.authority = program.cpu_rolling
        self.graphs = {}

    def dispatch(self, vm, candidates, *, normalize=True):
        if len(candidates) > vm.tile:
            raise ValueError('Candidate batch exceeds allocated tile')
        rows = decode_instruction_rows(candidates, vm.F)
        padded = np.zeros((vm.tile, 32, 6), dtype=np.int32)
        padded[:len(candidates)] = rows
        vm.phase_rows.from_numpy(padded)
        count = len(candidates)
        if not count:
            return
        indices, active_counts = active_row_indices(rows, vm.tile)
        vm.phase_indices.from_numpy(indices)
        if vm.graph_dispatch:
            from .phase_graph import InstructionGraph
            key = vm.compensated_coarse
            if key not in self.graphs:
                self.graphs[key] = InstructionGraph(vm)
            self.graphs[key].run(vm, rows, active_counts, normalize=normalize)
            return
        for step in range(max(map(len, candidates))):
            if self.authority:
                tokens = rows[:, step, 0]
                ops = tokens-64
                needs = ((ops >= 13) & (ops <= 17)) | (ops == 23) | ((ops >= 30) & (ops <= 32)) | (ops == 34) | ((ops >= 46) & (ops <= 49)) | (ops == 36) | (ops == 38) | (ops == 39)
                if np.any(needs & rows[:, step, 5].astype(bool)):
                    self._phase_prefix(count, step, 0, vm.phase_rows, vm.stack, vm.prefix)
            self._phase_instruction(active_counts[step], step, 0, vm.features,
                vm.phase_rows, vm.phase_indices, vm.stack, vm.prefix)
            if rows[:, step, 4].any():
                self._phase_copy_scratch(count, step, vm.phase_rows, vm.stack)
        self._phase_statistics(count, int(vm.legacy), vm.phase_rows, vm.stack, vm.phase_stats, vm.prefix)
        if self.authority:
            if normalize:
                self._phase_prefix(count, -1, 0, vm.phase_rows, vm.stack, vm.prefix)
            self._phase_output(count, int(normalize), vm.norm_window, 0,
                vm.stack, vm.factors, vm.prefix, vm.phase_stats)
        elif normalize:
            if vm.compensated_coarse:
                vm.program._coarse_terms(count, 0, vm.stack, vm.coarse_terms)
                vm.program._normalize_compensated_coarse(count, vm.norm_window, 0,
                    vm.stack, vm.factors, vm.prefix, vm.coarse_terms)
            else:
                vm.program._normalize_coarse(count, vm.norm_window, vm.stack, vm.factors, vm.prefix)
        else:
            self._phase_output(count, 0, vm.norm_window, 0,
                vm.stack, vm.factors, vm.prefix, vm.phase_stats)

    @ti.kernel
    def _phase_instruction(self, count: ti.i32, step: ti.i32, guard: ti.i64,
            features: ti.types.ndarray(ndim=2), rows: ti.types.ndarray(dtype=ti.i32, ndim=3), indices: ti.types.ndarray(dtype=ti.i32, ndim=2),
            stack: ti.types.ndarray(ndim=3), prefix: ti.types.ndarray(dtype=ti.f64, ndim=3)):
        T = stack.shape[2]
        span = ((T+255)//256)*256
        ti.loop_config(block_dim=256)
        for idx in range(count*span):
            p, t = indices[step, idx//span], idx%span
            if t < T and rows[p, step, 5] != 0:
                token, src, other, dst = rows[p, step, 0], rows[p, step, 1], rows[p, step, 2], rows[p, step, 3]
                if token < 64 or token >= 115:
                    stack[p, dst, t] = features[token if token < 64 else 62 + (token - 115), t]
                else:
                    op = token-64
                    value = ti.cast(0, self.dtype)
                    if op <= 5 or op == 29 or op == 35 or op == 36:
                        value = self.math.binary(p, src, other, t, op, guard,
                            stack, prefix, stack, 0, False)
                    else:
                        value = self.math.unary(p, src, t, op, guard,
                            stack, prefix, stack, 0, False)
                    stack[p, dst, t] = value

    @ti.kernel
    def _phase_copy_scratch(self, count: ti.i32, step: ti.i32,
            rows: ti.types.ndarray(dtype=ti.i32, ndim=3), stack: ti.types.ndarray(ndim=3)):
        ti.loop_config(block_dim=256)
        for p, t in ti.ndrange(count, stack.shape[2]):
            if rows[p, step, 4] != 0 and rows[p, step, 5] != 0:
                stack[p, rows[p, step, 1], t] = stack[p, 8, t]

    @ti.kernel
    def _phase_prefix(self, count: ti.i32, step: ti.i32, guard: ti.i64,
            rows: ti.types.ndarray(dtype=ti.i32, ndim=3), stack: ti.types.ndarray(ndim=3),
            prefix: ti.types.ndarray(dtype=ti.f64, ndim=3)):
        ti.loop_config(block_dim=256)
        for idx in range(count*256):
            p, lane = idx//256, idx%256
            scan_x = ti.simt.block.SharedArray((256,), ti.f64)
            scan_sq = ti.simt.block.SharedArray((256,), ti.f64)
            if step < 0:
                self.math.rolling_prefix(p, lane, 0, 0, guard, stack, prefix, scan_x, scan_sq)
            elif rows[p, step, 5] != 0:
                op, src = rows[p, step, 0]-64, rows[p, step, 1]
                if 13 <= op <= 17 or op == 23 or 30 <= op <= 32 or op == 34 or 46 <= op <= 49:
                    self.math.rolling_prefix(p, lane, src, 0, guard, stack, prefix, scan_x, scan_sq)
                elif op == 36:
                    self.math.rolling_prefix(p, lane, src, 0, guard, stack, prefix, scan_x, scan_sq)
                    self.math.rolling_prefix(p, lane, rows[p, step, 2], 2, guard, stack, prefix, scan_x, scan_sq)
                elif op == 38 or op == 39:
                    self.math.rolling_ema(p, lane, src, 4, 5 if op == 38 else 20, guard, stack, prefix, scan_x)

    @ti.kernel
    def _phase_statistics(self, count: ti.i32, legacy: ti.i32,
            rows: ti.types.ndarray(dtype=ti.i32, ndim=3), stack: ti.types.ndarray(ndim=3),
            stats: ti.types.ndarray(dtype=ti.f64, ndim=2), prefix: ti.types.ndarray(dtype=ti.f64, ndim=3)):
        T = stack.shape[2]
        ti.loop_config(block_dim=256)
        for idx in range(count*256):
            p, lane = idx//256, idx%256
            red = ti.simt.block.SharedArray((256,), ti.f64)
            causal = legacy == 0
            for step in range(32):
                token = rows[p, step, 0]
                if rows[p, step, 5] != 0 and (40 <= token < 64 or token >= 104):
                    causal = True
            total = ti.cast(0, ti.f64)
            for offset in range((T+255-lane)//256):
                total = total+ti.cast(stack[p, 0, lane+offset*256], ti.f64)
            red[lane] = total
            ti.simt.block.sync()
            step = 128
            while step > 0:
                if lane < step:
                    red[lane] = red[lane]+red[lane+step]
                ti.simt.block.sync()
                step = step//2
            mean = red[0]/T
            ti.simt.block.sync()
            total = ti.cast(0, ti.f64)
            for offset in range((T+255-lane)//256):
                z = ti.cast(stack[p, 0, lane+offset*256], ti.f64)-mean
                total = total+z*z
            red[lane] = total
            ti.simt.block.sync()
            step = 128
            while step > 0:
                if lane < step:
                    red[lane] = red[lane]+red[lane+step]
                ti.simt.block.sync()
                step = step//2
            raw_sd = ti.sqrt(red[0]/T)
            ti.simt.block.sync()
            if lane == 0:
                stats[p, 0], stats[p, 1] = raw_sd, ti.cast(causal, ti.f64)
                if ti.static(not self.authority):
                    prefix[p, 0, 0], prefix[p, 1, 0] = raw_sd, ti.cast(causal, ti.f64)

    @ti.kernel
    def _phase_output(self, count: ti.i32, normalize: ti.i32, norm_window: ti.i32, guard: ti.i64,
            stack: ti.types.ndarray(ndim=3), factors: ti.types.ndarray(dtype=ti.f64, ndim=2),
            prefix: ti.types.ndarray(dtype=ti.f64, ndim=3), stats: ti.types.ndarray(dtype=ti.f64, ndim=2)):
        ti.loop_config(block_dim=256)
        for p, t in ti.ndrange(count, factors.shape[1]):
            value = ti.cast(stack[p, 0, t], ti.f64)
            if ti.static(self.authority):
                if normalize != 0 and not (stats[p, 1] == 0 and stats[p, 0] < 1e-6):
                    lo = ti.max(0, t-norm_window+1)
                    s1 = prefix[p, 0, t+1]-prefix[p, 0, lo]
                    s2 = prefix[p, 1, t+1]-prefix[p, 1, lo]
                    n = ti.cast(t-lo+1, ti.f64)
                    mean = self.math.divide(s1, n, guard)
                    variance = self.math.divide(s2, n, guard)-self.math.rounded(mean*mean, guard)
                    sd = ti.sqrt(ti.max(variance, 0.0))
                    numerator = self.math.rounded(value-mean, guard)
                    value = ti.min(3.0, ti.max(-3.0, numerator/ti.max(sd, 1e-8)))
                    if self.math.is_nan(mean) or self.math.is_nan(variance):
                        value = ti.cast(float('nan'), ti.f64)
            factors[p, t] = value
