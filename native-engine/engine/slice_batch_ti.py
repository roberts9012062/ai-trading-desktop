"""Batch frozen slice reports without eagerly writing the CPU-compatible cache."""
from collections import defaultdict

from factor_lab.market import is_v2
from factor_lab.scoring.periods import bars_per_year
from .vm_ti import StackVM, validate_tokens


def slice_metrics(base, opened, session):
    return {name: base[name] for name in ('ann_ret', 'sortino', 'calmar', 'ts_ic', 'avg_turnover', 'exposure', 'bars')} | {
        'live_fill_ann_ret': opened['ann_ret'], 'live_fill_sortino': opened['sortino'],
        'session_ann_ret': session['ann_ret'], 'session_sortino': session['sortino']}


class BatchSlices:
    def __init__(self, context, *, tile=16):
        if not isinstance(tile, int) or not 1 <= tile <= 16:
            raise ValueError('Invalid slice batch width')
        self.context, self.tile = context, tile
        self.results = {}
        self.buffers = None

    @staticmethod
    def key(tokens, lo, hi, cost):
        return (tuple(tokens), int(lo), int(hi), float(cost))

    def prefetch(self, candidates, requests):
        from .wf_ti import _slice_start, MIN_TEST_BARS, _SEG_RESULTS
        unique = list(dict.fromkeys(tuple(tokens) for tokens in candidates))
        groups = defaultdict(list)
        for lo, hi, cost in dict.fromkeys(requests):
            if hi-lo < MIN_TEST_BARS:
                for tokens in unique:
                    self.results[self.key(tokens, lo, hi, cost)] = None
                continue
            for tokens in unique:
                key = self.key(tokens, lo, hi, cost)
                if key not in self.results:
                    start = _slice_start(self.context, tokens, lo)
                    cached_key = ('slice', tokens, self.context.signature(start, hi),
                                  self.context.timeframe, round(cost, 10))
                    if cached_key in _SEG_RESULTS:
                        # Read the existing alias only at the original scalar
                        # call. No LRU writes here. If it is evicted meanwhile,
                        # evaluate_on_slice retains its normal scalar fallback.
                        continue
                    groups[start, hi].append((tokens, lo, cost))
        for (start, hi), work in groups.items():
            data = self.context._context(start, hi)
            availability = data['availability']
            valid = []
            for tokens in dict.fromkeys(tokens for tokens, _, _ in work):
                try:
                    validate_tokens(tokens, data['features'].matrix.shape[0])
                    missing = any(52 <= token < 64 and not availability['finite_features'][token]
                                  and (not is_v2(data['bars']) or not availability['continuous_features'][token])
                                  for token in tokens)
                    if not missing:
                        valid.append(tokens)
                except (ValueError, TypeError):
                    pass
            settings = list(dict.fromkeys((lo, cost) for _, lo, cost in work))
            for tokens in set(tokens for tokens, _, _ in work)-set(valid):
                for lo, cost in settings:
                    self.results[self.key(tokens, lo, hi, cost)] = None
            if not valid:
                continue
            width = min(self.tile, len(valid))
            vm, reports = self.context.batch_buffers(data, width)
            self.buffers = (vm, reports)
            for offset in range(0, len(valid), width):
                tokens = valid[offset:offset+width]
                vm.dispatch([list(t) for t in tokens])
                for lo, cost in settings:
                    periods = bars_per_year(data['bars'][lo-start:], self.context.timeframe)
                    base, opened, session = reports.evaluate_slice_modes(vm.factors, len(tokens),
                        lo-start, hi-start, cost, periods)
                    for t, a, b, c in zip(tokens, base, opened, session):
                        self.results[self.key(t, lo, hi, cost)] = slice_metrics(a, b, c)
            # Scalar output dictionaries retain no device buffer references.
            self.buffers = None
            del vm, reports

    def peek(self, tokens, lo, hi, cost):
        """Read the existing alias before a prefetched value, without LRU writes."""
        from .wf_ti import _slice_start, _SEG_RESULTS
        start = _slice_start(self.context, tokens, lo)
        key = ('slice', tuple(tokens), self.context.signature(start, hi),
               self.context.timeframe, round(cost, 10))
        return _SEG_RESULTS[key] if key in _SEG_RESULTS else self.results.get(self.key(tokens, lo, hi, cost))

    def dispose(self):
        self.buffers = None
        self.results.clear()
