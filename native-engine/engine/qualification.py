"""Metadata-only qualification; never optimize a search against sealed data."""
import math
from numbers import Real


def _finite(value):
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def _nonfinite(value):
    if isinstance(value, dict):
        return any(_nonfinite(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_nonfinite(item) for item in value)
    return isinstance(value, Real) and not isinstance(value, bool) and not math.isfinite(value)


def _integer(value):
    # Frozen _round_metrics serializes integer counters/calendar coordinates
    # as integral floats. Validate their value rather than rejecting that ABI.
    return _finite(value) and float(value).is_integer()


def _positive(report, key='sortino'):
    return isinstance(report, dict) and _finite(report.get(key)) and report[key] > 0


def qualify_candidates(candidates, task_requirements, *, final_generation):
    """Partition the frozen candidate order; do not mutate, rerank or backfill.

    Native strict proof comes from the numerical owner. DSR/PBO/turnover remain
    informational: product approved existing gates, not new numeric thresholds.
    """
    result = {'champions': [], 'pending': [], 'rejected': []}
    for candidate in candidates:
        metrics, reasons = candidate.get('metrics') or {}, []
        if metrics.get('native_strict_passed') is not True:
            reasons.append('strict_screen_failed_or_unproven')
        if metrics.get('candidate_status') in ('exploratory', 'rejected') or metrics.get('overfit_warning'):
            reasons.append('research_only_candidate')
        if not task_requirements.get('sample_sufficient', True) or metrics.get('insufficient_samples'):
            reasons.append('insufficient_samples')
        visible = ({key: value for key, value in metrics.items() if key not in ('holdout_metrics', 'holdout_passed')}
                   if not final_generation else metrics)
        if (not _finite(candidate.get('composite')) or _nonfinite(visible)
                or not all(_finite(metrics.get(key)) for key in ('sortino', 'ann_ret'))):
            reasons.append('nonfinite_metric')
        if not task_requirements.get('test_required'):
            reasons.append('oos_validation_unavailable')
        elif not _positive(metrics.get('test_metrics')):
            reasons.append('oos_validation_failed_or_missing')
        if task_requirements.get('live_fill_gate') and not _positive(metrics.get('test_metrics'), 'live_fill_sortino'):
            reasons.append('live_fill_failed_or_missing')
        if task_requirements.get('execution_required') and not _positive(metrics.get('execution_metrics')):
            reasons.append('execution_failed_or_missing')
        if task_requirements.get('wf_folds', 0) > 0:
            wf = metrics.get('walk_forward') or {}
            if wf.get('wf_stable') is not True:
                reasons.append('wf_failed_or_missing')
            actual_oos = []
            for fold in wf.get('folds') or []:
                if not isinstance(fold, dict):
                    continue
                if fold.get('in_train') is False:
                    actual_oos.append(fold.get('test'))
                elif 'in_train' not in fold:
                    start, end = fold.get('score_start'), fold.get('score_end')
                    if (_integer(start) and _integer(end) and end > start
                            and start >= task_requirements.get('train_end', 0)):
                        actual_oos.append(fold)
            count = wf.get('n_oos_folds')
            if not _integer(count) or count < 1 or count != len(actual_oos):
                reasons.append('wf_oos_evidence_missing')
            elif not all(_positive(fold) for fold in actual_oos):
                reasons.append('wf_oos_fold_failed')
        sealed = task_requirements.get('holdout_required', False)
        if sealed and final_generation:
            holdout = metrics.get('holdout_metrics')
            if not _positive(holdout):
                reasons.append('holdout_failed_or_missing')
            if task_requirements.get('holdout_stress_required') and not _positive(holdout, 'sortino_2x'):
                reasons.append('holdout_stress_failed_or_missing')
            if task_requirements.get('live_entry_gate', 0) > 0 and 'live_discrete_sortino' in (holdout or {}):
                if not _positive(holdout, 'live_discrete_sortino'):
                    reasons.append('holdout_live_entry_failed')
        status = 'rejected' if reasons else ('pending' if sealed and not final_generation else 'qualified')
        if status == 'pending':
            reasons = ['holdout_sealed']
        item = dict(candidate, qualification={'status': status, 'reasons': list(dict.fromkeys(reasons))})
        result['champions' if status == 'qualified' else status].append(item)
    return result


def trusted_prefetched(requested, native_proofs):
    """Client token keys select proof; client pass/fail values have no authority."""
    return {key: native_proofs[key] for key in requested if key in native_proofs}


def requirements_for_context(metadata, full_length):
    """Read task splits/gates only; no numerical series evaluation on host."""
    plan = metadata.get('plan')
    model = metadata.get('execution_model', 'signal_research')
    return {'test_required': bool(metadata.get('use_test')),
            'train_end': len(metadata['train_bars']),
            'wf_folds': int(metadata.get('walk_forward_folds') or 0),
            'sample_sufficient': plan is None or bool(plan.sufficient),
            'holdout_required': (bool(plan.sufficient and plan.holdout_end > plan.validation_end)
                                 if plan is not None else full_length > len(metadata['all_bars'])),
            'holdout_stress_required': plan is not None,
            'live_fill_gate': bool(metadata.get('live_fill_gate')),
            'live_entry_gate': float(metadata.get('live_entry_gate') or 0),
            'execution_required': plan is not None and model in ('spot_long_flat', 'perp_next_open')}
