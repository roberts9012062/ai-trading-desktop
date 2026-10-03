"""Final-only f64 portfolio; frozen training weights, sealed scoring only."""
import taichi as ti

from .reductions_ti import block_tree_sum, compensated_add
from .vm_ti import _StackProgram

_program = None


def portfolio_bounds(session):
    meta, n = session.strict_metadata, len(session.prepared['bars'])
    plan = meta.get('plan')
    train_end = len(meta['train_bars'])
    if plan is not None:
        if not plan.sufficient:
            return None
        return train_end, plan.validation_end, plan.holdout_end-plan.tail_unclear_bars, 'holdout'
    if not meta.get('use_test'):
        return None
    sealed = len(meta['all_bars']) < n
    return train_end, len(meta['all_bars']) if sealed else train_end, n, 'holdout' if sealed else 'test'


def evaluate_portfolio(session, champions, *, diagnostics=False, combo_super=False, combo_source=None):
    """All series/statistics stay on CUDA; only scalar reports leave the GPU.

    成员池可含研究级候选(仅未过 2× 成本压力的因子):组合对冲会降低净换手
    与成本拖累,组合书在加倍成本下的存活能力可以强于任何单个成员。
    equal/ic_weighted 各按 1× 与 2× 成本双口径在封存段计分,成员的
    research 标记一并输出,由上层判定"组合超级冠军"。

    combo_super(组合因子勾选):追加折检验——组合仓位在验证区(v2:
    [train_end, validation_end);旧口径:测试段)按任务折数均分,每折 1×
    Sortino 全正且封存段 2× Sortino>0 才判 super_passed,与单因子资格门
    同构(折 1×/封存压力 2×)。关闭时返回结构与原口径逐位一致。
    """
    if len(champions) < 2:
        return None
    bounds = portfolio_bounds(session)
    if bounds is None:
        return None
    train_end, lo, hi, segment = bounds
    if not 2 <= train_end <= lo < hi <= len(session.prepared['bars']) or hi-lo < 2:
        raise ValueError('Invalid frozen portfolio boundaries')
    from .wf_ti import GpuResearchContext
    from factor_lab.scoring.periods import bars_per_year
    bars = session.prepared['bars']
    context = GpuResearchContext(bars, str(session.config.get('timeframe') or '1d'), session.prepared['cost'],
                                 resident=session.prepared['resident_full'])
    global _program
    if _program is None:
        _program = _PortfolioProgram()
    program = _program
    try:
        data = context._context(0, len(bars))
        K, T = len(champions), len(bars)
        factors = ti.ndarray(ti.f64, shape=(K, T))
        positions = ti.ndarray(ti.f64, shape=(K, T))
        report = data['reports']
        for index, champion in enumerate(champions):
            data['vm'].dispatch([champion['tokens']])
            program._portfolio_copy(data['vm'].factors, factors, index)
            report.program._positions(data['vm'].factors, report.positions, 1, 0, 0)
            program._portfolio_copy(report.positions, positions, index)
        means = ti.ndarray(ti.f64, shape=(K, 2))
        ics = ti.ndarray(ti.f64, shape=K)
        report.program._means(factors, report.source, means, K, 0, train_end, 0)
        report.program._centered(factors, report.source, means, ics, K, 0, train_end, 0)
        weights = ti.ndarray(ti.f64, shape=K)
        weight_sum = ti.ndarray(ti.f64, shape=1)
        program._portfolio_weights(ics, weights, weight_sum, K)
        combination = ti.ndarray(ti.f64, shape=(1, T))
        periods = bars_per_year(bars, str(session.config.get('timeframe') or '1d'))

        def metrics(mode, index=0, scale=1.0):
            program._portfolio_combine(positions, weights, combination, K, mode, index, 0)
            program._portfolio_flows(report.source, combination, report.flows, session.prepared['cost'] * scale, 0)
            values = report._summarize(combination, 1, lo, hi, periods, 0)[0]
            return {name: values[name] for name in ('ann_ret', 'sortino', 'calmar')}

        equal = metrics(0)
        ti.sync()
        has_weights = float(weight_sum.to_numpy()[0]) > 1e-9
        weighted = metrics(1) if has_weights else None
        singles = [metrics(2, index) for index in range(K)]
        singles_2x = [metrics(2, index, 2.0) for index in range(K)]
        full_means = ti.ndarray(ti.f64, shape=K)
        correlations = ti.ndarray(ti.f64, shape=K*K)
        avg_corr = ti.ndarray(ti.f64, shape=1)
        program._portfolio_means(factors, full_means, K)
        program._portfolio_correlations(factors, full_means, correlations, K)
        program._portfolio_corr_summary(correlations, avg_corr, K)
        ti.sync()
        # 成员是否为研究级(唯一拒因属于执行级门槛)——组合救活的候选来源
        execution_only = {'holdout_stress_failed_or_missing', 'holdout_live_entry_failed',
                          'live_fill_failed_or_missing', 'execution_failed_or_missing'}
        member_research = []
        for champion in champions:
            reasons = ((champion.get('qualification') or {}).get('reasons') or [])
            member_research.append(bool(reasons) and all(r in execution_only for r in reasons))
        equal_2x = metrics(0, 0, 2.0)
        weighted_2x = (metrics(1, 0, 2.0) if has_weights else None)
        # 折检验(组合因子):组合仓位在验证区(v2)/测试段(旧口径)按任务折数
        # 均分,每折 1× Sortino;区域不足折数或折数=0 时跳过(只验 2× 封存)。
        fold_detail = None
        folds = int((session.strict_metadata or {}).get('walk_forward_folds') or 0) if combo_super else 0
        if folds > 0:
            plan = session.strict_metadata.get('plan')
            wf_lo = train_end
            wf_hi = lo if (plan is not None and plan.sufficient) else hi
            span = wf_hi - wf_lo
            if span >= folds:
                def _fold_sortinos(mode):
                    program._portfolio_combine(positions, weights, combination, K, mode, 0, 0)
                    program._portfolio_flows(report.source, combination, report.flows, session.prepared['cost'], 0)
                    return [report._summarize(combination, 1, wf_lo + span * i // folds,
                                              wf_lo + span * (i + 1) // folds, periods, 0)[0]['sortino']
                            for i in range(folds)]
                fold_detail = {'equal': _fold_sortinos(0),
                               'ic_weighted': _fold_sortinos(1) if has_weights else None}
        result = {'n_factors': K, 'avg_abs_corr': round(float(avg_corr.to_numpy()[0]), 3),
                  'equal': equal, 'ic_weighted': weighted,
                  'best_single': max(singles, key=lambda row: row['sortino']),
                  'equal_2x': equal_2x, 'ic_weighted_2x': weighted_2x,
                  'best_single_2x': max(singles_2x, key=lambda row: row['sortino']),
                  'members': [list(c['tokens']) for c in champions],
                  'member_research': member_research,
                  'any_member_research': any(member_research),
                  'segment': segment, 'eval_bars': hi-lo}
        if combo_super:
            def _mode_ok(stress, sortinos):
                if stress is None or not (stress['sortino'] > 0):
                    return False
                return sortinos is None or all(s > 0.0 for s in sortinos)

            equal_ok = _mode_ok(equal_2x, fold_detail['equal'] if fold_detail else None)
            ic_ok = _mode_ok(weighted_2x, fold_detail['ic_weighted'] if fold_detail else None)
            shown = (fold_detail or {}).get('ic_weighted' if (ic_ok and not equal_ok) else 'equal')
            result['combo_super'] = True
            result['combo_source'] = combo_source
            result['super_passed'] = bool(equal_ok or ic_ok)
            if equal_ok or ic_ok:
                result['pass_mode'] = 'equal' if equal_ok else 'ic_weighted'
            if fold_detail:
                result['wf_fold_sortinos'] = shown
                result['wf_fold_sortinos_ic'] = fold_detail['ic_weighted']
                result['wf_stable'] = shown is None or all(s > 0.0 for s in shown)
            else:
                result['wf_stable'] = True
        if diagnostics:
            result['weights'] = weights.to_numpy().tolist()
        return result
    finally:
        context.dispose()


@ti.data_oriented
class _PortfolioProgram:
    def __init__(self):
        self.math = _StackProgram('f64')

    @ti.kernel
    def _portfolio_copy(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=2), row: ti.i32):
        for t in range(out.shape[1]):
            out[row, t] = source[0, t]

    @ti.kernel
    def _portfolio_weights(self, ics: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), total: ti.types.ndarray(dtype=ti.f64, ndim=1), K: ti.i32):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            value, correction = ti.cast(0., ti.f64), ti.cast(0., ti.f64)
            for block in range((K+255)//256):
                k = block*256+lane
                if k < K:
                    value, correction = compensated_add(value, correction, ti.max(0., ics[k]))
            shared[lane, 0] = value
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                total[0] = shared[0, 0]
            for block in range((K+255)//256):
                k = block*256+lane
                if k < K:
                    out[k] = 0.
                    if shared[0, 0] > 1e-9:
                        out[k] = ti.max(0., ics[k])/shared[0, 0]

    @ti.kernel
    def _portfolio_combine(self, positions: ti.types.ndarray(dtype=ti.f64, ndim=2), weights: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=2), K: ti.i32, mode: ti.i32, index: ti.i32, guard: ti.i64):
        for t in range(out.shape[1]):
            value = ti.cast(0., ti.f64)
            if mode == 2:
                value = positions[index, t]
            else:
                for k in range(K):
                    term = positions[k, t]
                    if mode == 1:
                        term = self.math.rounded(term*weights[k], guard)
                    value = self.math.rounded(value+term, guard)
                if mode == 0:
                    value = self.math.divide_real(value, ti.cast(K, ti.f64), guard)
            out[0, t] = value

    @ti.kernel
    def _portfolio_flows(self, source: ti.types.ndarray(dtype=ti.f64, ndim=2), positions: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=3), cost: ti.f64, guard: ti.i64):
        T = positions.shape[1]
        for t in range(T):
            previous = ti.cast(0., ti.f64)
            if t > 0:
                previous = positions[0, t-1]
            turn = ti.abs(self.math.rounded(positions[0, t]-previous, guard))
            ret = ti.cast(0., ti.f64)
            if t+1 < T:
                ret = self.math.divide_real(self.math.rounded(source[0, t+1]-source[0, t], guard), ti.max(ti.abs(source[0, t]), 1e-9), guard)
            fee = self.math.rounded(turn*cost, guard)
            out[0, 0, t] = self.math.rounded(self.math.rounded(positions[0, t]*ret, guard)-fee, guard)
            out[0, 1, t], out[0, 2, t] = positions[0, t], fee
            out[0, 3, t], out[0, 4, t], out[0, 5, t] = 0., turn, 0.

    @ti.kernel
    def _portfolio_means(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), out: ti.types.ndarray(dtype=ti.f64, ndim=1), K: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(K*256):
            k, lane, T = idx//256, idx%256, factors.shape[1]
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            value, correction = ti.cast(0., ti.f64), ti.cast(0., ti.f64)
            for chunk in range((T+255)//256):
                t = chunk*256+lane
                if t < T:
                    value, correction = compensated_add(value, correction, factors[k, t])
            shared[lane, 0] = value
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[k] = shared[0, 0]/T

    @ti.kernel
    def _portfolio_correlations(self, factors: ti.types.ndarray(dtype=ti.f64, ndim=2), means: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), K: ti.i32):
        ti.loop_config(block_dim=256)
        for idx in range(K*K*256):
            pair, lane, T = idx//256, idx%256, factors.shape[1]
            a, b = pair//K, pair%K
            shared = ti.simt.block.SharedArray((256, 3), ti.f64)
            total, correction = ti.Vector.zero(ti.f64, 3), ti.Vector.zero(ti.f64, 3)
            for chunk in range((T+255)//256):
                t = chunk*256+lane
                if t < T:
                    x, y = factors[a, t]-means[a], factors[b, t]-means[b]
                    values = ti.Vector([x*x, y*y, x*y])
                    for j in ti.static(range(3)):
                        total[j], correction[j] = compensated_add(total[j], correction[j], values[j])
            for j in ti.static(range(3)):
                shared[lane, j] = total[j]
            block_tree_sum(shared, lane, 3)
            if lane == 0:
                out[pair] = 0.
                if a != b:
                    out[pair] = ti.abs(ti.min(1., ti.max(-1., shared[0, 2]/ti.sqrt(shared[0, 0])/ti.sqrt(shared[0, 1]))))

    @ti.kernel
    def _portfolio_corr_summary(self, correlations: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), K: ti.i32):
        ti.loop_config(block_dim=256)
        for lane in range(256):
            shared = ti.simt.block.SharedArray((256, 1), ti.f64)
            value, correction = ti.cast(0., ti.f64), ti.cast(0., ti.f64)
            for chunk in range((K*K+255)//256):
                pair = chunk*256+lane
                if pair < K*K:
                    value, correction = compensated_add(value, correction, correlations[pair])
            shared[lane, 0] = value
            block_tree_sum(shared, lane, 1)
            if lane == 0:
                out[0] = shared[0, 0]/(K*(K-1))
