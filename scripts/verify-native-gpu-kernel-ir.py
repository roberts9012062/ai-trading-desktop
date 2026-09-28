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


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    log_path = args.out.with_suffix(".ir.log")
    g1_path = args.out.with_suffix(".g1.json")
    with log_path.open("wb") as log:
        result = subprocess.run([sys.executable, str(ROOT / "scripts/verify-native-gpu-determinism.py"),
                                 "--precision", "both", "--out", str(g1_path)],
                                cwd=ROOT, env={**os.environ, "TI_PRINT_IR": "1"},
                                stdout=log, stderr=subprocess.STDOUT, timeout=180)
    data = log_path.read_bytes()
    lines = data.decode("utf-8", errors="replace").splitlines()
    # Ignore compiler phase headings such as 'Demote atomics'. Inspect actual
    # IR instructions. Requiring no atomic instruction also rules out f32/f64.
    atomic = [line for line in lines if re.search(r"\batomic\s+(?:add|sub|min|max|and|or|xor|exchange)\b", line)]
    required = ("_execute", "_positions", "_pnl_cache", "_summary", "_means", "_centered", "_draw_blocks", "_merge_draw", "_finish")
    compiled = {name: any(name in line for line in lines) for name in required}
    report = {"gate": "4.3-fixed-reductions", "compiler_exit": result.returncode,
              "compiled": compiled, "atomic_instructions": atomic,
              "ir_sha256": hashlib.sha256(data).hexdigest(),
              "passed": result.returncode == 0 and all(compiled.values()) and not atomic}
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
