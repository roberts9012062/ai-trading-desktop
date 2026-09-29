"""Task-frozen session. GPU inputs stay resident until explicit disposal."""
import copy
import json
from datetime import datetime, timezone

import numpy as np

from . import ENGINE_TAG
from .protocol import decode_columns
from .runtime import plan_tile


def candidate_work(tokens):
    """Fixed scheduling weights; never used for admission, scores or ranking."""
    value = len(tokens)
    for token in tokens:
        op = token - 64
        if 13 <= op <= 17 or op == 23 or 30 <= op <= 32 or op == 34 or 46 <= op <= 49:
            value += 8
        elif op in (29, 35, 36):
            value += 40 if op == 29 else 24
        elif op in (18, 19, 20, 21, 22, 33, 40, 41, 42, 43):
            value += 4
    return value


class NativeSession:
    def __init__(self, session_id, runtime, precision="mixed"):
        self.session_id, self.runtime, self.precision = session_id, runtime, precision
        self.bars = None
        self.prepared = self.vm = self.coarse_vm = self.metrics = None
        self.finite_features = None
        self.config_key = None
        self.config = self.strict_context = self.dedup_context = self.joint_context = None
        self.strict_metadata = None
        self.prefix_signatures = {}
        self.regime_inputs = None
        self.disposed = False

    def _alive(self):
        if self.disposed:
            raise ValueError("Session disposed; restart mining task")

    def load_records(self, bars, metadata):
        self._alive()
        limit = metadata.get("max_bars")
        if limit not in (100_000, 200_000, 300_000) or not 2 <= len(bars) <= limit:
            raise ValueError("Bar range exceeds device-profile guard")
        if self.bars is not None:
            raise ValueError("Cannot replace task-frozen bars")
        self.bars = copy.deepcopy(bars)

    def load_bars(self, columns, metadata):
        count = metadata.get("count")
        decoded = decode_columns(columns, count, metadata.get("max_bars"))
        if "time_idx" not in decoded or "close" not in decoded:
            raise ValueError("Missing time_idx/close columns")
        strings = metadata.get("string_columns", {})
        if not isinstance(strings, dict):
            raise ValueError("Invalid bar string metadata")
        for name, values in strings.items():
            if (name not in ("time", "market_source", "_factor_market")
                    or not isinstance(values, list) or len(values) != count
                    or any(value is not None and not isinstance(value, str) for value in values)):
                raise ValueError("Invalid bar string column/shape")
        records = []
        for i in range(count):
            time_ms = decoded["time_idx"][i]
            if not np.isfinite(time_ms):
                raise ValueError("Invalid bar timestamp")
            bar = {key: (float(value[i]) if np.isfinite(value[i]) else None)
                   for key, value in decoded.items() if key != "time_idx"}
            bar["time"] = datetime.fromtimestamp(time_ms / 1000, timezone.utc).isoformat()
            for name, values in strings.items():
                bar[name] = values[i]
            records.append(bar)
        self.load_records(records, metadata)

    def prepare_features(self, config):
        self._alive()
        if self.bars is None:
            raise ValueError("Session bars not loaded")
        key = json.dumps(config, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if self.prepared is not None:
            if key != self.config_key:
                raise ValueError("Task-frozen configuration mismatch")
            return self.feature_info()
        from .features_ti import prepare_features
        from .vm_ti import StackVM
        from .metrics_ti import TrainingMetrics
        frozen_config = copy.deepcopy(config)
        prepared = prepare_features(self.bars, frozen_config)
        F, T = prepared["matrix"].shape
        tile = plan_tile(T, F, max(1, int(config.get("population") or 3000)),
                         self.precision, self.runtime["vram_mb"])
        # Preserve the missing-data mask for token admission. The CPU oracle
        # retains leading NaNs; they must not be turned into fabricated signals.
        vm = StackVM(prepared["matrix"], "f64", tile=tile,
                          norm_window=prepared["norm_window"], normalization=prepared["normalization"])
        metrics = TrainingMetrics(prepared["close"], prepared["cost"], prepared["periods"],
                                       tile=tile, head_trim=prepared["head_trim"])
        availability = prepared["availability"]
        finite_features = [f < 52 or finite or (prepared["normalization"] == "causal_v2"
                                          and f >= 52 and availability["continuous_features"][f])
                                for f, finite in enumerate(availability["finite_features"])]
        from factor_local import _strict_eval_context
        from .signatures import freeze_prefix_signatures, report_prefix_ends
        strict_metadata = _strict_eval_context(frozen_config, prepared['bars'])
        prefix_signatures = freeze_prefix_signatures(prepared['bars'],
            report_prefix_ends(strict_metadata, len(prepared['bars'])))
        regime_inputs = None
        if strict_metadata['use_test'] and strict_metadata['test_bars']:
            from .series_ti import GpuSeries
            from .selection_ti import prepare_regime_masks
            close = GpuSeries.upload([float(b.get('close') or 0) for b in strict_metadata['test_bars']])
            regime_inputs = (close, prepare_regime_masks(close))
        from factor_lab.market import is_crypto
        ends = sorted(end for start, end in prefix_signatures
                      if start == 0 and 2 <= end <= len(strict_metadata['all_bars']))
        # Prepare candidate-independent buffers only when every known prefix
        # fits the existing eight-context / 256 MiB cache. Scores, strict
        # verdicts and sealed-holdout contexts remain unevaluated.
        strict_context = None
        if (is_crypto(prepared['bars']) and strict_metadata['plan'] is None
                and len(ends) <= 8 and sum(27*end*8+16384 for end in ends) <= 256*1024*1024):
            from .strict_ti import StrictContext
            strict_context = StrictContext(prepared['bars'], frozen_config,
                resident=prepared['resident_full'], metadata=strict_metadata,
                signatures=prefix_signatures)
            try:
                for end in ends:
                    strict_context.research._context(0, end)
            except Exception:
                strict_context.dispose()
                raise
        # Publish one complete preparation. A failed allocation must leave
        # the frozen input retryable instead of accepting partial GPU state.
        self.vm, self.metrics = vm, metrics
        self.prepared, self.config_key, self.config = prepared, key, frozen_config
        self.finite_features = finite_features
        self.strict_metadata, self.prefix_signatures = strict_metadata, prefix_signatures
        self.regime_inputs, self.strict_context = regime_inputs, strict_context
        return self.feature_info()

    def feature_info(self):
        private = {"matrix", "close", "resident_full", "bars", "cfg", "availability"}
        return {k: v for k, v in self.prepared.items() if k not in private}

    def _accepted(self, candidates):
        self._alive()
        if self.prepared is None:
            raise ValueError("Features not prepared")
        from .vm_ti import validate_tokens
        from factor_lab.vm import validate
        accepted = []
        for candidate in candidates:
            try:
                validate_tokens(candidate, self.vm.F)
                if validate(candidate):
                    continue
                # v2 permits a leading direct-data prefix, as the CPU VM does.
                # Interior gaps and fully missing rows still reject execution.
                if any(t < 64 and not self.finite_features[t] for t in candidate):
                    continue
                accepted.append(candidate)
            except (ValueError, TypeError):
                continue
        return accepted

    def _tiles(self, accepted, tile):
        # Similar amounts of rolling work share a launch. This reduces idle SM
        # time at each tile's tail. Keep original indices, including duplicates,
        # so execution scheduling cannot alter JS evolution/tie-breaking order.
        ordered = sorted(enumerate(accepted), key=lambda item: candidate_work(item[1]), reverse=True)
        for start in range(0, len(ordered), tile):
            chunk = ordered[start:start + tile]
            yield [index for index, _ in chunk], [tokens for _, tokens in chunk]

    def rank_shards(self, candidates):
        """Non-authoritative f32 coarse scores; never expose them as metrics."""
        accepted = self._accepted(candidates)
        if self.precision != "mixed":
            raise ValueError("Coarse ranking requires mixed precision")
        if self.coarse_vm is None:
            from .vm_ti import StackVM
            self.coarse_vm = StackVM(self.prepared["matrix"], "mixed", tile=self.vm.tile,
                                     norm_window=self.prepared["norm_window"],
                                     normalization=self.prepared["normalization"])
        from .metrics_ti import METRIC_NAMES
        composite_index = METRIC_NAMES.index("composite")
        result = [None] * len(accepted)
        for indices, batch in self._tiles(accepted, self.coarse_vm.tile):
            self.coarse_vm.dispatch(batch)
            values = self.metrics.evaluate(self.coarse_vm.factors, len(batch), ranking_only=True, coarse_positions=True)
            for index, tokens, row in zip(indices, batch, values):
                if np.isfinite(row).all() and row[-1] >= 1e-6:
                    result[index] = {"tokens": list(tokens),
                                     "score": float(row[composite_index]) - .02 * max(0, len(tokens) - 12)}
        return [item for item in result if item is not None]

    def eval_shards(self, candidates):
        # Every returned candidate is recomputed from original f64 features.
        # Coarse ranking cannot replace the authoritative path or change validity.
        accepted = self._accepted(candidates)
        if self.config.get("joint_training") and self.joint_context is None:
            from .joint_ti import JointTraining
            self.joint_context = JointTraining(self.config, self.prepared["bars"][:self.prepared["train_len"]],
                                              str(self.config.get("timeframe") or "1d"), self.prepared["cost"],
                                              self.prepared["normalization"] == "causal_v2")
        from .metrics_ti import METRIC_NAMES
        result = [None] * len(accepted)
        for indices, batch in self._tiles(accepted, self.vm.tile):
            self.vm.dispatch(batch)
            values = self.metrics.evaluate(self.vm.factors, len(batch))
            for index, tokens, row in zip(indices, batch, values):
                if not np.isfinite(row).all() or row[-1] < 1e-6:
                    continue
                metrics = {name: float(row[k]) for k, name in enumerate(METRIC_NAMES[:-1])}
                metrics["oos_negative"] = bool(metrics["oos_negative"])
                metrics["kernel_version"] = ENGINE_TAG
                metrics["native_engine_version"] = self.runtime["engine_version"]
                metrics["native_precision"] = self.precision
                metrics["native_eval_precision"] = "f64"
                comp = float(metrics["composite"]) - .02 * max(0, len(tokens) - 12)
                if self.joint_context is not None:
                    comp, metrics = self.joint_context.score(tokens, comp, metrics)
                result[index] = {"tokens": list(tokens), "composite": comp, "metrics": metrics}
        return [item for item in result if item is not None]

    def strict_eval(self, candidates):
        self._alive()
        if self.prepared is None:
            raise ValueError("Features not prepared")
        from .strict_ti import StrictContext, strict_eval
        if self.strict_context is None:
            self.strict_context = StrictContext(self.prepared["bars"], self.config,
                                                resident=self.prepared["resident_full"],
                                                metadata=self.strict_metadata, signatures=self.prefix_signatures)
        return strict_eval(self.strict_context, candidates)

    def precise(self, payload):
        from .precise_ti import precise
        return precise(self, payload)

    def dispose(self):
        if self.joint_context is not None:
            self.joint_context.dispose()
        self.joint_context = None
        if self.dedup_context is not None:
            self.dedup_context.dispose()
        self.dedup_context = None
        if self.strict_context is not None:
            self.strict_context.dispose()
        self.strict_context = self.config = None
        self.strict_metadata = None
        self.prefix_signatures.clear()
        self.regime_inputs = None
        self.disposed = True
        self.bars = self.prepared = self.vm = self.coarse_vm = self.metrics = None
        self.finite_features = None
