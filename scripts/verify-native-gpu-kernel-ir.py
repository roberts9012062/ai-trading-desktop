"""Compile both VM precisions and metric kernels; reject atomic instructions."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def compile_copy_probe():
    """Compile the selection copy before an identical feature copy can alias it."""
    sys.path.insert(0, str(ROOT / "native-engine"))
    from engine.runtime import initialize_runtime
    initialize_runtime(require_cuda=True)
    import numpy as np
    import taichi as ti
    from engine.selection_ti import program
    source = ti.ndarray(ti.f64, shape=17)
    target = ti.ndarray(ti.f64, shape=(2, 17))
    expected = np.arange(17, dtype=np.float64)
    source.from_numpy(expected)
    target.fill(-1)
    program()._copy_center_row(source, target, 1)
    ti.sync()
    actual = target.to_numpy()
    if actual[1].tobytes() != expected.tobytes() or not np.all(actual[0] == -1):
        raise RuntimeError("Selection copy probe failed")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path)
    p.add_argument("--copy-probe", action="store_true", help=argparse.SUPPRESS)
    args = p.parse_args()
    if args.copy_probe:
        compile_copy_probe()
        return 0
    if args.out is None:
        p.error("--out is required")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    log_path = args.out.with_suffix(".ir.log")
    g1_path = args.out.with_suffix(".g1.json")
    with log_path.open("wb") as log:
        # Taichi's in-memory compiler cache aliases _copy_center_row to the
        # identical feature _copy_row body. A fresh process exposes its named
        # IR, while the full G1 process still exercises both actual call paths.
        probe = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--copy-probe"],
                               cwd=ROOT, env={**os.environ, "TI_PRINT_IR": "1"},
                               stdout=log, stderr=subprocess.STDOUT, timeout=30)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/verify-native-gpu-determinism.py"),
                                 "--precision", "both", "--out", str(g1_path)],
                                cwd=ROOT, env={**os.environ, "TI_PRINT_IR": "1"},
                                stdout=log, stderr=subprocess.STDOUT, timeout=300)
    # Ignore compiler phase headings such as 'Demote atomics'. Inspect actual
    # IR instructions. Requiring no atomic instruction also rules out f32/f64.
    required = ("_execute", "_normalize_coarse", "_coarse_terms", "_normalize_compensated_coarse", "_positions", "_coarse_positions", "_returns", "_pnl_cache", "_summary", "_means", "_centered", "_draw_blocks", "_merge_draw", "_finish",
                "_flows", "_discrete_positions", "_prefix", "_binary", "_unary", "_window", "_forward_fill", "_streak", "_strength",
                "_finite_count", "_copy_row", "_copy_prefix", "_deviation", "_std", "_pnl_stats", "_copy_factor", "_as_factor", "_copy_flow", "_dot_mean", "_dot_many", "_copy_center_row")
    required += ("_phase_instruction", "_phase_copy_scratch", "_phase_prefix",
                 "_phase_statistics", "_phase_output")
    compiled = dict.fromkeys(required, False)
    atomic, digest = [], hashlib.sha256()
    with log_path.open("rb") as log:
        for encoded in log:
            digest.update(encoded)
            line = encoded.decode("utf-8", errors="replace")
            initial = re.search(r"\[([a-z_]+)_c\d+_\d+\] Initial IR:", line)
            if initial and initial[1] in compiled:
                compiled[initial[1]] = True
            if re.search(r"\batomic\s+(?:add|sub|min|max|and|or|xor|exchange)\b", line):
                atomic.append(line.rstrip())
    report = {"gate": "4.3-fixed-reductions", "compiler_exit": result.returncode,
              "copy_probe_exit": probe.returncode,
              "compiled": compiled, "atomic_instructions": atomic,
              "ir_sha256": digest.hexdigest(),
              "passed": probe.returncode == 0 and result.returncode == 0 and all(compiled.values()) and not atomic}
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
