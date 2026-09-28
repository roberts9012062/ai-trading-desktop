"""G1 is mandatory before a CUDA engine may advertise availability."""
import hashlib

import numpy as np

TOKENS = ((0,), (1,), (2,), (0, 1, 64), (0, 1, 65), (0, 1, 66), (0, 1, 67),
          (0, 71), (0, 73), (0, 74), (0, 75), (0, 76), (0, 77), (0, 80),
          (0, 85), (0, 88), (0, 91), (0, 1, 93), (0, 104), (0, 106))


def compare_bytes(first, second):
    first, second = np.asarray(first), np.asarray(second)
    return (first.dtype == second.dtype and first.shape == second.shape and
            np.isfinite(first).all() and np.isfinite(second).all() and
            first.tobytes() == second.tobytes())


def run_startup_selfcheck(precision="mixed", *, inject_failure=False):
    from .vm_ti import StackVM
    from .metrics_ti import TrainingMetrics
    x = np.arange(1025, dtype=np.float64)
    matrix = np.vstack((np.sin(x / 9), np.cos(x / 17) + .2, np.sin(x / 31) - .1))
    close = 100 * np.exp(np.cumsum(.001 * np.sin(x / 11) + .00002))
    vm = StackVM(matrix, "f64", tile=20)
    metrics = TrainingMetrics(close, .0003, 365 * 24, tile=20)
    candidates = [list(tokens) for tokens in TOKENS]
    first_factor = vm.execute_batch(candidates)
    first_metrics = metrics.evaluate(vm.factors, 20)
    second_factor = vm.execute_batch(candidates)
    second_metrics = metrics.evaluate(vm.factors, 20)
    if inject_failure:
        second_metrics.view(np.uint64)[0, 0] ^= np.uint64(1)
    passed = compare_bytes(first_factor, second_factor) and compare_bytes(first_metrics, second_metrics)
    digest = hashlib.sha256(first_factor.tobytes() + first_metrics.tobytes())
    coarse_passed = None
    if precision == "mixed":
        coarse = StackVM(matrix, "mixed", tile=20)
        first_coarse = coarse.execute_batch(candidates)
        first_scores = metrics.evaluate(coarse.factors, 20)
        second_coarse = coarse.execute_batch(candidates)
        second_scores = metrics.evaluate(coarse.factors, 20)
        coarse_passed = compare_bytes(first_coarse, second_coarse) and compare_bytes(first_scores, second_scores)
        passed = passed and coarse_passed
        digest.update(first_coarse.tobytes() + first_scores.tobytes())
    return {"passed": bool(passed), "token_count": 20, "precision": precision,
            "eval_precision": "f64", "coarse_passed": coarse_passed, "sha256": digest.hexdigest()}
