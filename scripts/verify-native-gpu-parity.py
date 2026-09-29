"""Native vs unchanged CPU oracle. Full G2 never passes with M1-only coverage."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]


def grouped_rows(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[tuple(row["tokens"])].append(row)
    return grouped


def desktop_reference_order(candidates, workers):
    """Match the unchanged pool's round-robin shards/ordered Promise.all merge.

    Composite-zero ties make precise sensitive to its evaluated input order.
    This permutation is fixed by the reference worker count, never by scores,
    accepted tokens or champion membership.
    """
    if workers != 8:
        raise ValueError('Full G2 reference requires the original eight-worker pool')
    return [candidate for worker in range(workers) for candidate in candidates[worker::workers]]


def compare_evaluated(native, cpu):
    left, right = grouped_rows(native), grouped_rows(cpu)
    failures = []
    for key in sorted(left.keys() | right.keys()):
        if key not in left or key not in right:
            failures.append({"tokens": key, "reason": "validity mismatch"})
            continue
        if len(left[key]) != len(right[key]):
            failures.append({"tokens": key, "reason": "candidate multiplicity mismatch"})
        for lrow, rrow in zip(left[key], right[key]):
            a, b = float(lrow["composite"]), float(rrow["composite"])
            if not np.isfinite(a) or not np.isfinite(b):
                failures.append({"tokens": key, "reason": "nonfinite composite",
                                 "native": a if np.isfinite(a) else str(a),
                                 "cpu": b if np.isfinite(b) else str(b)})
                continue
            error = abs(a - b) / abs(b) if b != 0 else (0.0 if a == 0 else float("inf"))
            if error >= 1e-9:
                failures.append({"tokens": key, "native": a, "cpu": b,
                                 "relative_error": error if np.isfinite(error) else "Infinity"})
    return failures


def compare_full_outputs(native, cpu):
    """G2 thresholds over authoritative training, champion and strict outputs.

    Full suite orchestration also checks the 7x4 input/provenance coverage. This
    function alone does not certify G2 or enable M1's unavailable full pipeline.
    """
    required = ("evaluated", "champions", "strict")
    if any(not isinstance(output.get(key), list) for output in (native, cpu) for key in required):
        return {"passed": False, "reason": "missing full pipeline output"}
    errors = compare_evaluated(native["evaluated"], cpu["evaluated"])
    lresearch = native.get('research_candidates', native['champions'])
    rresearch = cpu.get('research_candidates', cpu['champions'])
    lr, rr = Counter(tuple(row['tokens']) for row in lresearch), Counter(tuple(row['tokens']) for row in rresearch)
    lg, rg = grouped_rows(lresearch), grouped_rows(rresearch)
    shared_research = lr & rr
    research_errors = compare_evaluated(
        [row for key, count in shared_research.items() for row in lg[key][:count]],
        [row for key, count in shared_research.items() for row in rg[key][:count]])
    research_denominator = max(sum(lr.values()), sum(rr.values()))
    research_overlap = sum(shared_research.values())/research_denominator if research_denominator else 1.
    qualification_integrity = True
    if 'research_candidates' in native:
        from engine.qualification import qualify_candidates
        requirements = native.get('qualification_requirements')
        if not isinstance(requirements, dict):
            qualification_integrity = False
        else:
            expected = qualify_candidates(lresearch, requirements, final_generation=True)['champions']
            qualification_integrity = (Counter(tuple(row['tokens']) for row in expected) ==
                Counter(tuple(row['tokens']) for row in native['champions']) and
                all(row.get('qualification', {}).get('status') == 'qualified' for row in native['champions']))
    lchamp = Counter(tuple(row["tokens"]) for row in native["champions"])
    rchamp = Counter(tuple(row["tokens"]) for row in cpu["champions"])
    lgroup, rgroup = grouped_rows(native["champions"]), grouped_rows(cpu["champions"])
    # Set differences belong to the approved 99% overlap gate. Apply the
    # composite gate to corresponding champions without turning 99% into 100%.
    shared = lchamp & rchamp
    champion_errors = compare_evaluated(
        [row for key, count in shared.items() for row in lgroup[key][:count]],
        [row for key, count in shared.items() for row in rgroup[key][:count]])
    denominator = max(sum(lchamp.values()), sum(rchamp.values()))
    overlap = sum((lchamp & rchamp).values()) / denominator if denominator else 1.0
    left, right = grouped_rows(native["strict"]), grouped_rows(cpu["strict"])
    strict_coverage = (left.keys() == right.keys() and
                       all(len(left[key]) == len(right[key]) for key in right))
    matches = total = 0
    valid_verdicts = True
    for key, rows in right.items():
        total += len(rows)
        for lrow, rrow in zip(left.get(key, []), rows):
            if not isinstance(lrow.get("pass"), bool) or not isinstance(rrow.get("pass"), bool):
                valid_verdicts = False
            elif lrow["pass"] == rrow["pass"]:
                matches += 1
    agreement = matches / total if total else 0.0
    # Validity differences remain failures even when aggregate overlaps would
    # round upward. A missing strict candidate is not an agreeing rejection.
    return {"composite_failures": errors, "champion_failures": champion_errors,
            "research_failures": research_errors, "research_candidate_overlap": research_overlap,
            "qualification_integrity": qualification_integrity,
            "champion_overlap": overlap, "cpu_champions": sum(rchamp.values()),
            "strict_agreement": agreement, "strict_coverage_equal": strict_coverage,
            "strict_candidates": total,
            "passed": bool(cpu["evaluated"]) and not errors and not champion_errors and
                      overlap >= .99 and research_overlap >= .99 and not research_errors and
                      qualification_integrity and strict_coverage and valid_verdicts and agreement >= .999}


def validate_suite(manifest):
    symbols, frames = manifest.get("symbols", []), manifest.get("timeframes", [])
    if (len(symbols) != 7 or len(set(symbols)) != 7 or
            len(frames) != 4 or len(set(frames)) != 4):
        raise ValueError("Full G2 requires seven distinct symbols and four distinct timeframes")
    cases = manifest.get("cases", [])
    keys = Counter((case.get("symbol"), case.get("timeframe")) for case in cases)
    expected = {(symbol, frame) for symbol in symbols for frame in frames}
    if set(keys) != expected or any(count != 1 for count in keys.values()):
        raise ValueError("Full G2 requires exactly one case for every 7x4 pair")
    for case in cases:
        if any(not isinstance(case.get(key), str) for key in ("bars", "config", "candidates", "cpu_reference")):
            raise ValueError("Each G2 case requires frozen bars/config/candidates/CPU-reference paths")
    return cases


def run_full(args):
    if args.suite is None or args.precision != "both":
        raise ValueError("Full G2 requires --suite and --precision both")
    manifest = json.loads(args.suite.read_text(encoding="utf-8"))
    diagnostic_case = getattr(args, "case", None)
    if diagnostic_case:
        requested = set(diagnostic_case)
        cases = [case for case in manifest.get("cases", [])
                 if f'{case.get("symbol")}/{case.get("timeframe")}' in requested]
        if len(cases) != len(requested) or len(requested) != len(diagnostic_case):
            raise ValueError("Case diagnostic requires distinct frozen symbol/timeframe cases")
    else:
        cases = validate_suite(manifest)
    from engine.runtime import initialize_runtime
    from engine.session import NativeSession
    native_sources = [*sorted((ROOT/'native-engine'/'engine').glob('*.py')),
                      *sorted((ROOT/'native-engine'/'engine').glob('*table.json')),
                      ROOT/'native-engine'/'VERSION', ROOT/'requirements-native.lock']
    native_hashes = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in native_sources}
    records = []
    for precision in ("mixed", "f64"):
        runtime = initialize_runtime(precision, require_cuda=True)
        for case in cases:
            def case_path(key):
                return args.suite.parent / case[key]
            bars_bytes = case_path("bars").read_bytes()
            bars = json.loads(bars_bytes)
            cfg = json.loads(case_path("config").read_text(encoding="utf-8"))
            tokens = json.loads(case_path("candidates").read_text(encoding="utf-8"))
            cpu = json.loads(case_path("cpu_reference").read_text(encoding="utf-8"))
            if (cpu.get("reference", {}).get("engine") != "desktop-pyodide" or
                    cpu.get("bars_sha256") != hashlib.sha256(bars_bytes).hexdigest() or
                    cpu.get("config") != cfg or cpu.get("candidates") != tokens or
                    cfg.get("symbol") != case["symbol"] or cfg.get("timeframe") != case["timeframe"]):
                raise ValueError("CPU reference provenance/input identity mismatch")
            source_hashes = cpu["reference"].get("source_sha256", {})
            mandatory = ("public/pykernel/factor_local.py", "public/pykernel/factor_lab/features.py",
                         "public/pykernel/factor_lab/vm.py", "public/pykernel/factor_lab/search.py",
                         "src/workers/pyodide-backtest.worker.ts", "src/lib/mining/gpu/shard-pool.ts")
            if any(name not in source_hashes for name in mandatory) or any(hashlib.sha256((ROOT/name).read_bytes()).hexdigest() != digest
                                        for name, digest in source_hashes.items()):
                raise ValueError("CPU reference numerical source identity mismatch")
            for name, field in (("public/pyodide/pyodide.asm.wasm", "wasm_sha256"),
                                ("public/pyodide/pyodide-lock.json", "pyodide_lock_sha256")):
                if cpu["reference"].get(field) != hashlib.sha256((ROOT/name).read_bytes()).hexdigest():
                    raise ValueError("CPU reference WASM dependency identity mismatch")
            strict_tokens = cpu.get("strict_candidates")
            if not isinstance(strict_tokens, list) or not strict_tokens or any(tuple(t) not in {tuple(c) for c in tokens} for t in strict_tokens):
                raise ValueError("CPU reference missing frozen strict shortlist")
            session = NativeSession("g2", runtime, precision)
            try:
                started = time.monotonic()
                label = f'{case["symbol"]}/{case["timeframe"]}/{precision}'
                print(f'G2 {label}: features', flush=True)
                session.load_records(bars, {"max_bars": 100_000})
                feature_info = session.prepare_features(cfg)
                if feature_info.get("features_source") != "gpu-taichi":
                    raise ValueError("Full G2 requires GPU features; M1 CPU PoC cannot be certified")
                if precision == "mixed":
                    session.rank_shards(tokens)
                evaluated = session.eval_shards(desktop_reference_order(tokens, cpu.get('cpu_workers')))
                eval_seconds = time.monotonic()-started
                print(f'G2 {label}: {len(evaluated)} authoritative candidates; strict', flush=True)
                strict = session.strict_eval(strict_tokens)
                print(f'G2 {label}: precise', flush=True)
                precise = session.precise({**cpu.get("precise_payload", {}), "evaluated": evaluated,
                                           "best_seen": [], "prefetched_strict": strict,
                                           "final_generation": True})
                from engine.qualification import qualify_candidates
                requirements = precise['qualification_requirements']
                # The unchanged oracle's _dedup_top always marks rejected
                # fallbacks with overfit_warning. Annotate this reference proof
                # in memory only; frozen source/reference files are untouched.
                cpu_research = [dict(row, metrics=dict(row['metrics'], native_strict_passed=
                    not bool(row['metrics'].get('overfit_warning')) and
                    row['metrics'].get('candidate_status') not in ('exploratory', 'rejected')))
                    for row in cpu['outputs']['champions']]
                cpu_qualified = qualify_candidates(cpu_research, requirements, final_generation=True)
                cpu_output = {**cpu['outputs'], 'research_candidates': cpu_research,
                              'champions': cpu_qualified['champions']}
                native = {"evaluated": evaluated, "strict": strict, "champions": precise["champions"],
                          'research_candidates': precise['research_candidates'],
                          'qualification_requirements': requirements,
                          'pending_candidates': precise['pending_candidates'],
                          'rejected_candidates': precise['rejected_candidates']}
                comparison = compare_full_outputs(native, cpu_output)
                records.append({"symbol": case["symbol"], "timeframe": case["timeframe"],
                                "precision": precision, "device": runtime,
                                "native_source_sha256": native_hashes,
                                "eval_seconds": eval_seconds, "total_seconds": time.monotonic()-started,
                                "bars_sha256": cpu["bars_sha256"], "comparison": comparison,
                                "native": native, "cpu": cpu_output})
                print(json.dumps({"symbol": case["symbol"], "timeframe": case["timeframe"],
                                  "precision": precision, "passed": comparison["passed"]}), flush=True)
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(json.dumps({"gate": "G2", "G2_complete": False, "passed": False,
                                               "diagnostic_case": diagnostic_case, "records": records},
                                              ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
            finally:
                session.dispose()
    passed = all(record["comparison"]["passed"] for record in records)
    qualified_reference_count = sum(len(record['cpu']['champions']) for record in records)
    passed = passed and (diagnostic_case or qualified_reference_count > 0)
    complete = not diagnostic_case and len(records) == 56 and passed and qualified_reference_count > 0
    report = {"gate": "G2", "G2_complete": complete, "passed": passed,
              "diagnostic_case": diagnostic_case,
              'qualified_reference_count': qualified_reference_count,
              "symbols": manifest["symbols"], "timeframes": manifest["timeframes"], "records": records}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return int(not passed)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bars", type=Path)
    p.add_argument("--candidates", type=Path)
    p.add_argument("--config", type=Path)
    p.add_argument("--suite", type=Path, help="Full G2 manifest with all 7x4 frozen cases")
    p.add_argument("--case", action="append", help="Repeat for frozen case diagnostics; never certifies G2")
    p.add_argument("--precision", choices=("mixed", "f64", "both"), default="mixed")
    p.add_argument("--stage", choices=("eval", "full"), default="eval")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--cpu-benchmark", type=Path,
                   help="Optional real eight-worker benchmark reference, with verified input identity")
    args = p.parse_args()
    if args.stage == "full":
        try:
            return run_full(args)
        except (ValueError, AttributeError) as exc:
            p.error(str(exc))
    if args.bars is None or args.candidates is None or args.config is None or args.precision == "both":
        p.error("Eval diagnostic requires --bars/--candidates/--config and one precision")
    from engine.runtime import initialize_runtime
    from engine.session import NativeSession
    import factor_local

    bars = json.loads(args.bars.read_text(encoding="utf-8"))
    tokens = json.loads(args.candidates.read_text(encoding="utf-8"))
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    runtime = initialize_runtime(args.precision, require_cuda=True)
    session = NativeSession("parity", runtime, args.precision)
    session.load_records(bars, {"max_bars": 100_000})
    session.prepare_features(cfg)
    native = session.eval_shards(tokens)
    reference = "unchanged CPython CPU oracle"
    if args.cpu_benchmark:
        baseline = json.loads(args.cpu_benchmark.read_text(encoding="utf-8"))
        if (baseline.get("cpuWorkers") != 8 or baseline.get("config") != cfg or
                baseline.get("candidates") != tokens or
                baseline.get("bars_sha256") != hashlib.sha256(args.bars.read_bytes()).hexdigest()):
            p.error("Cached CPU benchmark input identity does not match bars/config/candidates")
        cpu = baseline["cpu"]
        reference = "unchanged real eight-worker Pyodide pool (frozen benchmark output)"
    else:
        cpu = json.loads(factor_local.run(json.dumps({**cfg, "mode": "mine_eval_shard", "candidates": tokens}), json.dumps(bars)))["evaluated"]
    failures = compare_evaluated(native, cpu)
    report = {"stage": "eval", "G2_complete": False, "precision": args.precision,
              "device": runtime, "bars": len(bars), "candidates": len(tokens), "cpu_reference": reference,
              "failures": failures, "passed": not failures}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "failures"}, default=str))
    session.dispose()
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
