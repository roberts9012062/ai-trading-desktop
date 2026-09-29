"""GPU peer training windows and joint composite, with frozen time cutoffs."""
from collections import OrderedDict

import numpy as np

from factor_lab.market import prepare_bars
from factor_lab.research_context import norm_window_for_bars
from factor_lab.scoring.periods import bars_per_year
from factor_lab.vm import validate

from .features_ti import compute_features
from .metrics_ti import TrainingMetrics, METRIC_NAMES
from .vm_ti import StackVM, validate_tokens
from .wf_ti import _moments


class JointTraining:
    def __init__(self, config, train_bars, timeframe, cost, v2):
        self.peers, self.cache = [], OrderedDict()
        self.cost, self.v2 = float(cost), bool(v2)
        if not config.get('cross_peers') or not train_bars:
            return
        cut = str(train_bars[-1].get('time') or '')
        if not cut:
            return
        for symbol, raw in config['cross_peers']:
            bars = prepare_bars({**config, 'symbol': symbol}, raw)
            segment = [b for b in bars or [] if str(b.get('time') or '') and str(b.get('time') or '')<=cut]
            if len(segment)<max(480, len(train_bars)//4):
                continue
            features = compute_features(segment)
            availability = features.availability(crypto=True, max_head_gap=250 if v2 else 0)
            trim = availability['head_trim'] if v2 else 0
            vm = StackVM(features.matrix, 'f64', tile=1, norm_window=norm_window_for_bars(segment) if v2 else 250,
                          normalization='causal_v2' if v2 else 'legacy')
            metrics = TrainingMetrics([float(b.get('close') or 0) for b in segment], cost,
                                      bars_per_year(segment, timeframe), tile=1, head_trim=trim)
            self.peers.append({'symbol': symbol, 'features': features, 'vm': vm, 'metrics': metrics,
                               'availability': availability})

    def score(self, tokens, main_comp, main_metrics):
        if not self.peers:
            return main_comp, main_metrics
        key = tuple(tokens)
        scores = self.cache.get(key)
        if scores is None:
            scores = []
            for peer in self.peers:
                comp, sortino = 0.0, None
                try:
                    validate_tokens(tokens, peer['vm'].F)
                    if validate(tokens):
                        raise ValueError('Invalid peer candidate')
                    availability = peer['availability']
                    if any(52<=t<64 and not availability['finite_features'][t]
                           and not (self.v2 and availability['continuous_features'][t]) for t in tokens):
                        raise ValueError('Missing peer feature')
                    peer['vm'].dispatch([tokens])
                    values = peer['metrics'].evaluate(peer['vm'].factors, 1)[0]
                    if np.isfinite(values).all() and values[-1]>=1e-6:
                        comp = float(values[METRIC_NAMES.index('composite')])-.02*max(0, len(tokens)-12)
                        sortino = float(values[METRIC_NAMES.index('sortino')])
                except (ValueError, FloatingPointError, OverflowError):
                    pass
                scores.append((peer['symbol'], comp, sortino))
            self.cache[key] = scores
            while len(self.cache)>20000:
                self.cache.popitem(last=False)
        self.cache.move_to_end(key)
        comps = [main_comp]+[comp for _, comp, _ in scores]
        mean, sd = _moments(comps)
        joint = mean-.5*sd
        peer_sortino = {symbol: round(sortino, 4) for symbol, _, sortino in scores if sortino is not None}
        positives = int(float(main_metrics.get('sortino') or 0)>0)+sum(sortino is not None and sortino>0 for _, _, sortino in scores)
        return joint, {**main_metrics, 'joint_composite': joint, 'joint_pos_frac': positives/len(comps),
                       'joint_train_sortino': peer_sortino}

    def dispose(self):
        self.peers.clear()
        self.cache.clear()
