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
        records = []
        for i in range(count):
            time_ms = decoded["time_idx"][i]
            if not np.isfinite(time_ms):
                raise ValueError("Invalid bar timestamp")
            bar = {key: (float(value[i]) if np.isfinite(value[i]) else None)
                   for key, value in decoded.items() if key != "time_idx"}
            bar["time"] = datetime.fromtimestamp(time_ms / 1000, timezone.utc).isoformat()
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
        if config.get("joint_training"):
            raise ValueError("Joint training evaluation is M2; M1 cannot silently ignore it")
        from .poc_features import prepare_features
        from .vm_ti import StackVM
        from .metrics_ti import TrainingMetrics
        prepared = prepare_features(self.bars, config)
        F, T = prepared["matrix"].shape
        tile = plan_tile(T, F, max(1, int(config.get("population") or 3000)),
                         self.precision, self.runtime["vram_mb"])
        # Preserve the missing-data mask for token admission. The CPU oracle
        # retains leading NaNs; they must not be turned into fabricated signals.
        self.vm = StackVM(prepared["matrix"], "f64", tile=tile,
                          norm_window=prepared["norm_window"], normalization=prepared["normalization"])
        self.metrics = TrainingMetrics(prepared["close"], prepared["cost"], prepared["periods"],
                                       tile=tile, head_trim=prepared["head_trim"])
        self.prepared, self.config_key = prepared, key
        self.finite_features = np.isfinite(prepared["matrix"]).all(axis=1)
        return self.feature_info()

    def feature_info(self):
        return {k: v for k, v in self.prepared.items() if k not in ("matrix", "close")}

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
                # Reject any missing feature row in M1. A rejected direct-data
                # candidate is surfaced by parity, never substituted with zeros.
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
            values = self.metrics.evaluate(self.coarse_vm.factors, len(batch))
            for index, tokens, row in zip(indices, batch, values):
                if np.isfinite(row).all() and row[-1] >= 1e-6:
                    result[index] = {"tokens": list(tokens),
                                     "score": float(row[composite_index]) - .02 * max(0, len(tokens) - 12)}
        return [item for item in result if item is not None]

    def eval_shards(self, candidates):
        # Every returned candidate is recomputed from original f64 features.
        # Coarse ranking cannot replace the authoritative path or change validity.
        accepted = self._accepted(candidates)
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
                result[index] = {"tokens": list(tokens), "composite": comp, "metrics": metrics}
        return [item for item in result if item is not None]

    def dispose(self):
        self.disposed = True
        self.bars = self.prepared = self.vm = self.coarse_vm = self.metrics = None
        self.finite_features = None
