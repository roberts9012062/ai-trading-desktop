"""Native vs unchanged CPU oracle. Full G2 never passes with M1-only coverage."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]


def compare_evaluated(native, cpu):
    left = {tuple(e["tokens"]): e for e in native}
    right = {tuple(e["tokens"]): e for e in cpu}
    failures = []
    for key in sorted(left.keys() | right.keys()):
        if key not in left or key not in right:
            failures.append({"tokens": key, "reason": "validity mismatch"})
            continue
        a, b = float(left[key]["composite"]), float(right[key]["composite"])
        error = abs(a - b) / abs(b) if b != 0 else (0.0 if a == 0 else float("inf"))
        if not np.isfinite(a) or error >= 1e-9:
            failures.append({"tokens": key, "native": a, "cpu": b,
                             "relative_error": error if np.isfinite(error) else "Infinity"})
    return failures


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bars", type=Path, required=True)
    p.add_argument("--candidates", type=Path, required=True)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--precision", choices=("mixed", "f64"), default="mixed")
    p.add_argument("--stage", choices=("eval", "full"), default="eval")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--cpu-benchmark", type=Path,
                   help="Optional real eight-worker benchmark reference, with verified input identity")
    args = p.parse_args()
    if args.stage == "full":
        p.error("M1 does not implement precise/WF/strict; full G2 is incomplete until M2")
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
