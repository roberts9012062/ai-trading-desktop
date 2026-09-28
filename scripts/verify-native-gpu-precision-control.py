"""Isolate f32 expression rounding using the unchanged CPU normalization/scoring.

This is a diagnostic experiment, not a native implementation or G2 certificate.
No GPU or native VM is involved, so errors cannot be attributed to a GPU port.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public/pykernel")]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("bars", "config", "candidates", "out"):
        p.add_argument(f"--{name}", type=Path, required=True)
    args = p.parse_args()
    from engine.poc_features import prepare_features
    from factor_lab.ops import OPS_CONFIG
    from factor_lab.vm import execute, _normalize_output
    from factor_lab.scoring.evaluate import evaluate_factor
    bars = json.loads(args.bars.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    candidates = json.loads(args.candidates.read_text(encoding="utf-8"))
    prepared = prepare_features(bars, config)
    results = []
    for tokens in candidates:
        full = execute(tokens, prepared["matrix"], prepared["norm_window"], prepared["normalization"])
        if full is None:
            raise ValueError("Control requires valid CPU candidates")
        stack = []
        for token in tokens:
            if token < 64:
                stack.append(prepared["matrix"][token].astype(np.float32))
            else:
                _, fn, arity = OPS_CONFIG[token - 64]
                operands = [stack.pop() for _ in range(arity)][::-1]
                out = fn(*operands)
                stack.append(np.nan_to_num(np.asarray(out, dtype=np.float32), nan=0.0, posinf=1.0, neginf=-1.0))
        causal = prepared["normalization"] == "causal_v2" or any(40 <= token < 64 or token >= 104 for token in tokens)
        rounded = _normalize_output(stack[0].astype(np.float64), prepared["norm_window"], causal=causal)
        head = prepared["head_trim"]
        close = prepared["close"][head:]
        cpu = evaluate_factor(full[head:], close, prepared["cost"], prepared["periods"])["composite"]
        mixed = evaluate_factor(rounded[head:], close, prepared["cost"], prepared["periods"])["composite"]
        error = abs(cpu - mixed) / abs(cpu) if cpu else (0.0 if mixed == 0 else float("inf"))
        results.append({"tokens": tokens, "cpu_f64": cpu, "cpu_simulated_f32": mixed,
                        "relative_error": error if np.isfinite(error) else "Infinity",
                        "within_frozen_threshold": bool(error < 1e-9)})
    report = {"experiment": "CPU operators + per-node f32 rounding; unchanged CPU f64 normalization/scoring",
              "bars": len(bars), "train_bars": prepared["train_len"],
              "results": results, "all_within_frozen_threshold": all(r["within_frozen_threshold"] for r in results)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps(report, allow_nan=False))
    return 0 if report["all_within_frozen_threshold"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
