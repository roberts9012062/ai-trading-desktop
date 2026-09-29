"""G1 is mandatory before a CUDA engine may advertise availability."""
import hashlib
import msgpack

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
    from .metrics_ti import TrainingMetrics, NumericalReports, REPORT_NAMES
    from .features_ti import compute_features
    from datetime import datetime, timedelta, timezone
    x = np.arange(1025, dtype=np.float64)
    matrix = np.vstack((np.sin(x / 9), np.cos(x / 17) + .2, np.sin(x / 31) - .1))
    close = 100 * np.exp(np.cumsum(.001 * np.sin(x / 11) + .00002))
    # Compile the feature programs before hello so first-session JIT cannot
    # starve the five-second heartbeat. Exercise the real GPU feature graph.
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    bars = [{"time": (start + timedelta(minutes=15 * i)).isoformat(),
             "_factor_market": "crypto_local_v2", "open": float(value) - .1,
             "high": float(value) + 1, "low": float(value) - 1,
             "close": float(value), "volume": 1000 + i % 19,
             "open_interest": 20000 + i, "quote_volume": float(value) * 1000,
             "taker_buy_volume": 450 + i % 37, "trade_count": 20 + i % 13,
             "funding_rate": .0001, "long_short_ratio": 1 + i % 5 * .01,
             "liquidation_imbalance": i % 7 * .02} for i, value in enumerate(close)]
    features = compute_features(bars)
    feature_first = features.to_numpy()
    feature_second = compute_features(bars).to_numpy()
    features_passed = feature_first.tobytes() == feature_second.tobytes()
    features.availability(700, crypto=True, max_head_gap=250)
    vm = StackVM(matrix, "f64", tile=20, execution_layout="candidate_block")
    metrics = TrainingMetrics(close, .0003, 365 * 24, tile=20)
    candidates = [list(tokens) for tokens in TOKENS]
    first_factor = vm.execute_batch(candidates)
    first_metrics = metrics.evaluate(vm.factors, 20)
    second_factor = vm.execute_batch(candidates)
    second_metrics = metrics.evaluate(vm.factors, 20)
    phase = StackVM(matrix, "f64", tile=20, execution_layout="candidate_time_block")
    phase_first = phase.execute_batch(candidates)
    phase_second = phase.execute_batch(candidates)
    layouts_passed = compare_bytes(phase_first, phase_second) and compare_bytes(first_factor, phase_first)
    reports = NumericalReports(bars, tile=20)
    report_first = reports.evaluate(vm.factors, 20, 17, 1001, .0003, 365 * 96, mode="perp_next_open")
    report_second = reports.evaluate(vm.factors, 20, 17, 1001, .0003, 365 * 96, mode="perp_next_open")
    report_first = np.array([[item[name] for name in REPORT_NAMES] for item in report_first])
    report_second = np.array([[item[name] for name in REPORT_NAMES] for item in report_second])
    reports_passed = compare_bytes(report_first, report_second)
    discrete_first = reports.evaluate(vm.factors, 20, 17, 1001, .0003, 365 * 96, mode='discrete')
    discrete_second = reports.evaluate(vm.factors, 20, 17, 1001, .0003, 365 * 96, mode='discrete')
    discrete_first = np.array([[item[name] for name in REPORT_NAMES] for item in discrete_first])
    discrete_second = np.array([[item[name] for name in REPORT_NAMES] for item in discrete_second])
    reports_passed = reports_passed and compare_bytes(discrete_first, discrete_second)
    def triplet_bytes():
        triplet = reports.evaluate_slice_modes(vm.factors, 20, 17, 1001, .0003, 365*96)
        return np.asarray([[[item[name] for name in REPORT_NAMES] for item in mode] for mode in triplet])
    reports.graph_dispatch = False
    direct_triplet = triplet_bytes()
    reports.graph_dispatch = True
    graph_triplet_first, graph_triplet_second = triplet_bytes(), triplet_bytes()
    reports_passed = (reports_passed and compare_bytes(direct_triplet, graph_triplet_first)
                      and compare_bytes(graph_triplet_first, graph_triplet_second))
    # Warm selection/dedup reductions and all copy paths before availability;
    # inspect these compiled kernels in the same atomic audit as VM/metrics.
    from .selection_ti import (copy_factor, as_factor, copy_flow, moments,
                               block_robustness, dsr, regime_report, CenteredFactor, correlated_centered, CorrelationBank)
    from .series_ti import GpuSeries
    features.prefix(700)
    from .features_ti import compute_features as gpu_features
    legacy_bars = [dict(bar, _factor_market="crypto_ohlcv_v1") for bar in bars]
    gpu_features(legacy_bars)

    def selection_check():
        factor = copy_factor(vm.factors, 0)
        resident = as_factor(factor)
        robust = block_robustness(reports, resident, .0003, 365 * 96)
        pnl = copy_flow(reports.flows, 0, 0, len(bars))
        stats = moments(factor)
        deflated = dsr(pnl, 3000)
        regime = regime_report(GpuSeries.upload(close), pnl, 365 * 96)
        center = CenteredFactor(factor)
        correlation = correlated_centered(center, center)
        bank = CorrelationBank(factor.T, 2)
        bank.append(center)
        batch_correlation = bank.any_correlated(center)
        return {"robust": robust, "moments": stats, "dsr": deflated, "regime": regime,
                "correlation": correlation, "batch_correlation": batch_correlation}

    selection_first, selection_second = selection_check(), selection_check()
    selection_bytes = msgpack.packb(selection_first, use_bin_type=True)
    selection_passed = selection_bytes == msgpack.packb(selection_second, use_bin_type=True)
    # Warm final portfolio kernels on the same twenty token programs. The
    # sealed suffix is scored once per double-run and never sets the weights.
    from types import SimpleNamespace
    from .portfolio_ti import evaluate_portfolio
    portfolio_session = SimpleNamespace(
        config={'timeframe': '15m'},
        prepared={'bars': legacy_bars, 'resident_full': gpu_features(legacy_bars), 'cost': .0003},
        strict_metadata={'train_bars': legacy_bars[:700], 'all_bars': legacy_bars[:900], 'use_test': True, 'plan': None})
    portfolio_tokens = [{'tokens': tokens} for tokens in candidates]
    portfolio_first = evaluate_portfolio(portfolio_session, portfolio_tokens, diagnostics=True)
    portfolio_second = evaluate_portfolio(portfolio_session, portfolio_tokens, diagnostics=True)
    portfolio_bytes = msgpack.packb(portfolio_first, use_bin_type=True)
    def finite_report(value):
        if isinstance(value, dict):
            return all(finite_report(item) for item in value.values())
        if isinstance(value, list):
            return all(finite_report(item) for item in value)
        return not isinstance(value, float) or np.isfinite(value)
    portfolio_passed = bool(finite_report(portfolio_first) and portfolio_bytes == msgpack.packb(portfolio_second, use_bin_type=True))
    if inject_failure:
        second_metrics.view(np.uint64)[0, 0] ^= np.uint64(1)
    passed = layouts_passed and features_passed and reports_passed and selection_passed and portfolio_passed and compare_bytes(first_factor, second_factor) and compare_bytes(first_metrics, second_metrics)
    digest = hashlib.sha256(first_factor.tobytes() + first_metrics.tobytes())
    digest.update(feature_first.tobytes())
    digest.update(report_first.tobytes())
    digest.update(discrete_first.tobytes())
    digest.update(graph_triplet_first.tobytes())
    digest.update(selection_bytes)
    digest.update(portfolio_bytes)
    coarse_passed = None
    if precision == "mixed":
        coarse = StackVM(matrix, "mixed", tile=20, execution_layout="candidate_block")
        first_coarse = coarse.execute_batch(candidates)
        first_scores = metrics.evaluate(coarse.factors, 20, ranking_only=True, coarse_positions=True)
        second_coarse = coarse.execute_batch(candidates)
        second_scores = metrics.evaluate(coarse.factors, 20, ranking_only=True, coarse_positions=True)
        coarse_passed = compare_bytes(first_coarse, second_coarse) and compare_bytes(first_scores, second_scores)
        phase_coarse = StackVM(matrix, "mixed", tile=20, execution_layout="candidate_time_block")
        phase_coarse_first = phase_coarse.execute_batch(candidates)
        phase_coarse_second = phase_coarse.execute_batch(candidates)
        layouts_passed = layouts_passed and compare_bytes(phase_coarse_first, phase_coarse_second) and compare_bytes(first_coarse, phase_coarse_first)
        passed = passed and coarse_passed and layouts_passed
        digest.update(first_coarse.tobytes() + first_scores.tobytes())
        # Retain and warm the original coarse path, including its extreme-
        # magnitude arithmetic oracle used by the compensation fallback tests.
        original = StackVM(matrix, "mixed", tile=20, compensated_coarse=False, compensated_rolling=False, shared_windows=False, execution_layout="candidate_block")
        original_first = original.execute_batch(candidates)
        original_second = original.execute_batch(candidates)
        passed = passed and compare_bytes(original_first, original_second)
        digest.update(original_first.tobytes())
    return {"passed": bool(passed), "token_count": 20, "precision": precision,
            "eval_precision": "f64", "features_passed": features_passed, "reports_passed": reports_passed,
            "selection_passed": selection_passed, "layouts_passed": bool(layouts_passed),
            "portfolio_passed": portfolio_passed,
            "coarse_passed": coarse_passed, "sha256": digest.hexdigest()}
