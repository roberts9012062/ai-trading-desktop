"""GPU precise pipeline; CPU-compatible shortlist/archive scalar control."""
from collections import OrderedDict

from factor_local import _decode_seed_best, _decode_prefetched_strict, _round_metrics, _mark_local_only
from factor_lab.archive import BoundedArchive
from factor_lab.express import to_text
from factor_lab.market import is_crypto, CRYPTO_PROFILE, V2_PROFILE
from factor_lab.scoring.periods import bars_per_year
from factor_lab.search import _metric_fingerprint, _robust_key

from . import ENGINE_TAG
from .metrics_ti import NumericalReports
from .selection_ti import (copy_factor, copy_flow, as_factor, CenteredFactor, CorrelationBank,
                           block_robustness, dsr, regime_report)
from .series_ti import GpuSeries
from .strict_ti import strict_gate, strict_eval
from .wf_ti import (GpuResearchContext, evaluate_on_slice, executable_on_slice,
                    live_discrete_on_slice, walk_forward_eval, _slice_start)


class GpuDedup:
    def __init__(self, session, context):
        self.session, self.context = session, context
        self.meta = context.metadata
        self.bars, self.train, self.test = (self.meta[name] for name in ('all_bars', 'train_bars', 'test_bars'))
        self.cfg = session.prepared['cfg']
        self.cost, self.timeframe = self.meta['cost'], self.meta['timeframe']
        self.trim, self.plan = session.prepared['head_trim'], self.meta['plan']
        self.series = OrderedDict()
        self.prefetched_factors = {}
        self.centered = OrderedDict()
        self.full = None
        self.train_reports = None

    def full_context(self):
        if self.full is None:
            self.full = GpuResearchContext(self.session.prepared['bars'], self.timeframe, self.cost,
                                            resident=self.session.prepared['resident_full'])
            self.full.signatures.update(self.session.prefix_signatures)
        return self.full

    def dispose(self):
        self.series.clear()
        self.prefetched_factors.clear()
        self.centered.clear()
        self.train_reports = None
        if self.full is not None:
            self.full.dispose()
            self.full = None

    def factor_series(self, tokens):
        key = tuple(tokens)
        if key in self.series:
            self.series.move_to_end(key)
            return self.series[key]
        if not self.train:
            return None
        if key in self.prefetched_factors:
            result = self.prefetched_factors.pop(key)
        else:
            data = self.context.research.factor_context(tokens, 0, len(self.train))
            result = copy_factor(data['vm'].factors, 0, self.trim) if data is not None else None
        self.series[key] = result
        while len(self.series)>1 and sum(v.T for v in self.series.values() if v is not None)>3000000:
            self.series.popitem(last=False)
        return result

    def prefetch_factors(self, candidates):
        """Bounded factor snapshots; scalar access retains original LRU order."""
        from factor_lab.market import is_v2
        from .vm_ti import validate_tokens
        if not self.train or len(self.train)<=self.trim:
            return
        data = self.context.research._context(0, len(self.train))
        availability, valid = data['availability'], []
        capacity = min(128, 3000000//(len(self.train)-self.trim))
        for tokens in dict.fromkeys(tuple(t) for t in candidates):
            if tokens in self.series or tokens in self.prefetched_factors:
                continue
            try:
                validate_tokens(tokens, data['features'].matrix.shape[0])
                if any(52<=t<64 and not availability['finite_features'][t]
                       and (not is_v2(data['bars']) or not availability['continuous_features'][t]) for t in tokens):
                    continue
            except (ValueError, TypeError):
                continue
            valid.append(tokens)
            if len(valid)>=capacity:
                break
        if not valid or not capacity:
            return
        width = min(16, len(valid))
        vm, _ = self.context.research.batch_buffers(data, width)
        for offset in range(0, len(valid), width):
            chunk = valid[offset:offset+width]
            vm.dispatch([list(t) for t in chunk])
            for row, tokens in enumerate(chunk):
                self.prefetched_factors[tokens] = copy_factor(vm.factors, row, self.trim)

    def training_report(self):
        if self.train_reports is None:
            self.train_reports = (self.context.research._context(0, len(self.train))['reports']
                                  if self.trim == 0 else NumericalReports(self.train[self.trim:], tile=1))
        return self.train_reports

    def centered_factor(self, tokens, factor):
        key = tuple(tokens)
        if key in self.centered:
            self.centered.move_to_end(key)
            return self.centered[key]
        result = CenteredFactor(factor) if factor is not None else None
        self.centered[key] = result
        while len(self.centered)>1 and sum(v.T for v in self.centered.values() if v is not None)>3000000:
            self.centered.popitem(last=False)
        return result

    def enrich(self, item, trials, final, cross=None):
        comp, tokens, raw = item
        enriched = dict(raw)
        cfg, meta, research = self.cfg, self.meta, self.context.research
        if is_crypto(self.train or self.bars):
            first = (self.train or self.bars)[0]
            marker = first.get('_factor_market')
            enriched.update(crypto_profile=True, research_profile=marker if marker in (CRYPTO_PROFILE, V2_PROFILE) else CRYPTO_PROFILE,
                            periods=bars_per_year(self.train or self.bars, self.timeframe), cost=self.cost,
                            cost_model='static_fee_plus_tick_no_funding')
            source = first.get('market_source')
            if source:
                enriched['data_channel'] = source
            if source == 'gate_usdt' or any(52<=t<64 for t in tokens):
                enriched['research_only'] = True
        if self.plan is not None:
            enriched['split_plan'] = self.plan.to_summary()
            if not self.plan.sufficient:
                enriched.update(insufficient_samples=True, sample_gaps=list(self.plan.insufficiency_reasons))
        use_test = meta['use_test']
        lo = len(self.bars)-len(self.test)
        if use_test and self.train:
            train = evaluate_on_slice(research, tokens, 0, len(self.train))
            if train is not None:
                enriched['train_metrics'] = train
        if use_test and self.test:
            test = evaluate_on_slice(research, tokens, lo, len(self.bars))
            if test is not None:
                enriched['test_metrics'] = test
                if self.plan is not None:
                    enriched['validation_metrics'] = test
        folds = meta['walk_forward_folds']
        if folds>0 and self.bars:
            wf = walk_forward_eval(research, tokens, folds, len(self.train) if self.train else None, plan=self.plan)
            if wf is not None:
                enriched['walk_forward'] = wf
        if cross:
            enriched['cross_symbol'] = {key: round(value, 3) for key, value in cross.items()}
        model = meta['execution_model']
        if self.plan is not None and model in ('perp_next_open', 'spot_long_flat'):
            executable = executable_on_slice(research, tokens, lo, len(self.bars), model)
            if executable is not None:
                enriched['execution_metrics'] = executable
        if self.test and len(self.test)>=480:
            q, worst = len(self.test)//4, None
            for k in range(4):
                metrics = evaluate_on_slice(research, tokens, lo+k*q, lo+(k+1)*q if k<3 else len(self.bars))
                if metrics is not None:
                    value = float(metrics['sortino'])
                    worst = value if worst is None else min(value, worst)
            if worst is not None:
                enriched['oos_conservative'] = round(worst, 4)
        if use_test and self.test:
            start = _slice_start(research, tokens, lo)
            data = research.factor_context(tokens, start, len(self.bars), recompute=True)
            if data is not None:
                report = data['reports']
                report._cashflows(data['vm'].factors, 1, lo-start, len(self.bars)-start, self.cost, 'close', .3, 1)
                pnl = copy_flow(report.flows, 0, lo-start, len(self.bars)-start)
                close, masks = self.session.regime_inputs
                enriched['regime'] = regime_report(close, pnl, bars_per_year(self.test, self.timeframe), masks=masks)
        if trials>0:
            enriched['trials'] = trials
        if cfg.selection_v2:
            full_bars = self.session.prepared['bars']
            n_holdout = len(full_bars)-len(self.bars) if self.plan is None else 0
            if final and n_holdout:
                hm = evaluate_on_slice(self.full_context(), tokens, len(self.bars), len(full_bars))
                if hm is not None:
                    if meta['live_entry_gate']>0:
                        lm = live_discrete_on_slice(self.full_context(), tokens, len(self.bars), len(full_bars), meta['live_entry_gate'])
                        if lm is not None:
                            hm.update(live_discrete_sortino=lm['sortino'], live_discrete_ann_ret=lm['ann_ret'])
                    enriched['holdout_metrics'] = hm
            factor = self.factor_series(tokens)
            if factor is not None and self.train and trials>0:
                # Preserve the oracle's training calendar for DSR. A trimmed
                # factor with an untrimmed close calendar is an explicit error,
                # rather than silently changing its published report formula.
                if factor.T != len(self.train):
                    raise ValueError('CPU DSR factor/close calendar mismatch')
                report = self.training_report()
                matrix = as_factor(factor)
                report._cashflows(matrix, 1, 0, factor.T, self.cost, 'close', .3, 1)
                value = dsr(copy_flow(report.flows, 0, 0, factor.T), trials)
                if value is not None:
                    enriched['dsr'] = round(value, 4)
        enriched['kernel_version'] = ENGINE_TAG
        return {'tokens': list(tokens), 'text': to_text(tokens), 'metrics': enriched, 'composite': comp}

    def enrich_many(self, items, trials, final):
        """Batch frozen slices, then consume them in the original cache order."""
        from .slice_batch_ti import BatchSlices
        from .wf_ti import MIN_TEST_BARS
        research = self.context.research
        previous, batch = research.prefetched_slices, None
        full, full_previous, holdout_batch = None, None, None
        try:
            if 2 <= len(items) <= 128:
                n, cost, requests = len(self.bars), self.cost, []
                lo = n-len(self.test)
                if self.meta['use_test']:
                    if self.train:
                        requests.append((0, len(self.train), cost))
                    if self.test:
                        requests.append((lo, n, cost))
                folds = self.meta['walk_forward_folds']
                if self.plan is None and folds > 0:
                    seg = n//(folds+1)
                    if seg >= MIN_TEST_BARS:
                        for i in range(1, folds+1):
                            a, b = i*seg, (i+1)*seg if i<folds else n
                            requests.extend(((0, a, cost), (a, b, cost)))
                if self.test and len(self.test)>=480:
                    q = len(self.test)//4
                    requests.extend((lo+k*q, lo+(k+1)*q if k<3 else n, cost) for k in range(4))
                if requests:
                    batch = BatchSlices(research)
                    # This computes no verdicts and writes no segment-cache
                    # entries. Each original enrich call still owns cache reads,
                    # aliases, insertion and LRU movement in its original order.
                    batch.prefetch([item[1] for item in items], requests)
                    research.prefetched_slices = batch.results
                if final and self.cfg.selection_v2 and self.plan is None and len(self.session.prepared['bars']) > n:
                    full = self.full_context()
                    full_previous = full.prefetched_slices
                    holdout_batch = BatchSlices(full)
                    holdout_batch.prefetch([item[1] for item in items], [(n, len(full.bars), cost)])
                    full.prefetched_slices = holdout_batch.results
            return [self.enrich(item[:3], trials, final, item[3]) for item in items]
        finally:
            research.prefetched_slices = previous
            if full is not None:
                full.prefetched_slices = full_previous
            if holdout_batch is not None:
                holdout_batch.dispose()
            if batch is not None:
                batch.dispose()

    def dedup(self, champions, trials, final, prefetched):
        try:
            if self.cfg.selection_v2 and len(champions)>=4:
                ordered, seen_tokens, seen_metrics = [], set(), set()
                for item in sorted(champions, key=lambda x:x[0], reverse=True):
                    key, fp = tuple(item[1]), _metric_fingerprint(item[2])
                    if key in seen_tokens or (fp is not None and fp in seen_metrics):
                        continue
                    seen_tokens.add(key)
                    if fp is not None:
                        seen_metrics.add(fp)
                    ordered.append(item[1])
                self.prefetch_factors(ordered)
            return self._dedup(champions, trials, final, prefetched)
        finally:
            self.prefetched_factors.clear()

    def _dedup(self, champions, trials, final, prefetched):
        cfg = self.cfg
        seen, uniq = set(), []
        for item in sorted(champions, key=lambda x:x[0], reverse=True):
            key = tuple(item[1])
            if key not in seen:
                seen.add(key); uniq.append(item)
        top_n = cfg.top_n
        shortlist = uniq[:max(top_n*3, top_n+5)]
        n_cap = max(2, min(top_n, round(trials**.5/2))) if trials>0 else top_n
        factors = None
        pbo_pool = shortlist[:max(2*n_cap, n_cap+10)]
        scan_pos, fps = 0, set()
        target = max(3*top_n, 30)

        def corr_dup(factor):
            nonlocal factors
            if factor is None:
                return False
            if factors is None:
                factors = CorrelationBank(factor.T, max(1, min(len(uniq), 3*target)))
            return factors.any_correlated(factor)

        def fill_distinct(limit):
            nonlocal scan_pos
            got, robust, scanned = [], {}, 0
            while scan_pos<len(uniq) and len(got)<limit and scanned<limit*10:
                item = uniq[scan_pos]; scan_pos += 1
                fp = _metric_fingerprint(item[2])
                if fp is not None:
                    if fp in fps:
                        continue
                    fps.add(fp)
                scanned += 1
                factor = self.factor_series(item[1])
                centered = self.centered_factor(item[1], factor)
                if factor is None or corr_dup(centered):
                    continue
                factors.append(centered)
                if self.train:
                    pf, ms = block_robustness(self.training_report(), as_factor(factor), self.cost, bars_per_year(self.train, self.timeframe))
                    robust[tuple(item[1])] = _robust_key(item[0], pf, ms)
                got.append(item)
            got.sort(key=lambda x:robust.get(tuple(x[1]), x[0]), reverse=True)
            return got

        if cfg.selection_v2:
            shortlist = pbo_pool = fill_distinct(target)
        strict_pool, n_failed = [], 0
        insufficient = self.plan is not None and not self.plan.sufficient
        if not insufficient:
            pool_iter, extensions = list(pbo_pool), 0
            while True:
                missing = [item[1] for item in pool_iter if tuple(item[1]) not in prefetched]
                resolved = {tuple(row['tokens']): (row['pass'], row['cross_scores'])
                            for row in strict_eval(self.context, missing)} if missing else {}
                for item in pool_iter:
                    tokens = item[1]
                    hit = prefetched.get(tuple(tokens), resolved.get(tuple(tokens)))
                    ok, cross = hit if hit is not None else strict_gate(tokens, self.context)
                    if not ok:
                        n_failed += 1
                        continue
                    if not cfg.selection_v2:
                        factor = self.factor_series(tokens)
                        centered = self.centered_factor(tokens, factor)
                        if corr_dup(centered):
                            continue
                        if factor is not None:
                            factors.append(centered)
                    strict_pool.append((*item, cross))
                if not (cfg.selection_v2 and final and len(strict_pool)<n_cap and extensions<2):
                    break
                pool_iter = fill_distinct(target)
                if not pool_iter:
                    break
                extensions += 1
                pbo_pool = pbo_pool+pool_iter
                shortlist = pbo_pool
        pbo = round(n_failed/len(pbo_pool), 3) if pbo_pool and self.meta['use_test'] else None
        result = self.enrich_many(strict_pool[:n_cap], trials, final)
        for c in result:
            c['metrics']['native_strict_passed'] = True
            if pbo is not None:
                c['metrics']['pbo_proxy'] = pbo
            if self.plan is not None:
                c['metrics'].update(validation_passed=True, candidate_status='validation_passed')
        if result:
            return result
        fallback = self.enrich_many([(*item, None) for item in shortlist[:n_cap]], trials, final)
        for c in fallback:
            m = c['metrics']
            m['native_strict_passed'] = False
            if self.plan is not None:
                if not self.plan.sufficient:
                    m.update(candidate_status='exploratory', exploratory_reason='样本不足,仅探索: '+'; '.join(self.plan.insufficiency_reasons))
                else:
                    m['candidate_status'] = 'rejected'
                m['overfit_warning'] = '验证区未通过严格筛(样本不足或 sortino/WF 不达标):该结果仅供研究参考,不计入合格因子数。'
            else:
                m['overfit_warning'] = '测试段 sortino≤0 或 walk-forward 不稳健：该因子在搜索时未见的近期数据上亏损，过拟合风险高，仅供参考。'
            result.append(c)
        return result

    def reveal_holdout(self, champions):
        if self.plan is None or not self.plan.sufficient:
            return
        plan = self.plan
        lo, hi = plan.validation_end, plan.holdout_end-plan.tail_unclear_bars
        if hi<=lo:
            return
        context = self.full_context()
        start = max(0, lo-plan.warmup)
        for champion in champions:
            m = champion['metrics']
            if not m.get('validation_passed'):
                continue
            data = context.factor_context(champion['tokens'], start, hi, recompute=True)
            if data is None:
                continue
            periods = bars_per_year(data['bars'][lo-start:], self.timeframe)
            base = data['reports'].evaluate(data['vm'].factors, 1, lo-start, hi-start, self.cost, periods)[0]
            stress = data['reports'].evaluate(data['vm'].factors, 1, lo-start, hi-start, self.cost*2, periods)[0]
            m['holdout_metrics'] = {name: base[name] for name in ('ann_ret', 'sortino', 'avg_turnover', 'bars')}
            m['holdout_metrics']['sortino_2x'] = stress['sortino']
            m['holdout_passed'] = base['sortino']>0 and stress['sortino']>0
            if m['holdout_passed']:
                m['candidate_status'] = 'holdout_passed'


def precise(session, payload):
    session._alive()
    # Resident-buffer estimate is UI metadata only. The pure-Python walk over
    # the accumulated dedup/strict caches costs hundreds of milliseconds, so
    # the session cache is filled before this generation populates them and
    # refreshed only after the final portfolio really allocated new buffers.
    if getattr(session, 'gpu_buffer_mb', None) is None:
        from .memory import session_buffer_mb
        session.gpu_buffer_mb = session_buffer_mb(session)
    if session.prepared is None:
        raise ValueError('Features not prepared')
    if session.strict_context is None:
        from .strict_ti import StrictContext
        session.strict_context = StrictContext(session.prepared['bars'], session.config,
            resident=session.prepared['resident_full'], metadata=session.strict_metadata,
            signatures=session.prefix_signatures)
    if session.dedup_context is None:
        session.dedup_context = GpuDedup(session, session.strict_context)
    best = list(_decode_seed_best(payload.get('best_seen')) or [])
    best = [item for item in best if item[2].get('kernel_version') == ENGINE_TAG
            and item[2].get('native_eval_precision') == 'f64'
            and item[2].get('native_engine_version') == session.runtime['engine_version']]
    candidates = payload.get('candidates') or []
    best.extend((item['composite'], item['tokens'], item['metrics']) for item in session.eval_shards(candidates))
    for item in payload.get('evaluated') or []:
        if not isinstance(item, dict):
            continue
        metrics = item.get('metrics') or {}
        if ('sortino' not in metrics or metrics.get('kernel_version') != ENGINE_TAG or metrics.get('native_eval_precision') != 'f64'
                or metrics.get('native_engine_version') != session.runtime['engine_version']):
            continue
        tokens = [int(t) for t in item.get('tokens') or [] if isinstance(t, (int, float))]
        if tokens:
            best.append((float(item.get('composite') or 0), tokens, metrics))
    trials, final = int(payload.get('trials') or 0), bool(payload.get('final_generation', True))
    from .qualification import qualify_candidates, requirements_for_context, trusted_prefetched
    prefetched = trusted_prefetched(_decode_prefetched_strict(payload.get('prefetched_strict')),
                                   session.strict_context.verdicts)
    champions = session.dedup_context.dedup(best, trials, final, prefetched)
    for c in champions:
        c['metrics'] = _mark_local_only(_round_metrics(c['metrics']), c['tokens'])
    # shortline_v1 与 crypto_local_v2 同属 v2 语义族(research_context.is_v2_family,
    # 与 features_ti 的归一化判定一致):末代封存解封与有界档案必须同样生效。
    # 修复前这里只字面匹配 crypto_local_v2,短线任务末代永远产不出
    # holdout_metrics,资格判定全数栽在 holdout_failed_or_missing 上(0 冠军)。
    from factor_lab.research_context import is_v2_family
    v2 = is_v2_family(str(session.prepared['cfg'].research_profile or ""))
    if v2 and final:
        session.dedup_context.reveal_holdout(champions)
    if v2:
        archive = BoundedArchive(); archive.extend(best); best = archive.snapshot()
    else:
        best = sorted(best, key=lambda x:x[0], reverse=True)[:60]
    requirements = requirements_for_context(session.strict_context.metadata, len(session.prepared['bars']))
    qualified = qualify_candidates(champions, requirements, final_generation=final)
    result = {'champions': qualified['champions'], 'research_candidates': champions,
            'pending_candidates': qualified['pending'], 'rejected_candidates': qualified['rejected'],
            'qualification_requirements': requirements,
            'best_seen': [{'composite': comp, 'tokens': tokens, 'metrics': _round_metrics(metrics)}
                                                for comp, tokens, metrics in best]}
    if payload.get('include_portfolio'):
        from .portfolio_ti import evaluate_portfolio
        portfolio = None
        if final:
            # 组合成员池 = 执行级冠军 + 研究级候选(唯一拒因属于成本/执行压力门)。
            # 组合对冲可降低净换手与成本拖累——单个成员扛不住 2× 成本,组合书
            # 可能扛得住;组合本身在封存段按 1×/2× 双口径如实计分再分级。
            execution_only = {'holdout_stress_failed_or_missing', 'holdout_live_entry_failed',
                              'live_fill_failed_or_missing', 'execution_failed_or_missing'}
            pool = list(qualified['champions'])
            for c in qualified['rejected']:
                reasons = ((c.get('qualification') or {}).get('reasons') or [])
                if reasons and all(r in execution_only for r in reasons):
                    pool.append(c)
            if len(pool) >= 2:
                portfolio = evaluate_portfolio(session, pool)
        result['portfolio'] = portfolio
        if portfolio is not None:
            from .memory import session_buffer_mb
            session.gpu_buffer_mb = session_buffer_mb(session)
    result['gpu_buffer_mb'] = session.gpu_buffer_mb
    return result
