"""G1 real-device selfcheck. Non-CUDA and failed checks exit nonzero."""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native-engine"))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--precision", choices=("mixed", "f64", "both"), default="both")
    p.add_argument("--inject-failure", action="store_true")
    p.add_argument("--out", type=Path)
    args = p.parse_args()
    from engine.runtime import initialize_runtime
    from engine.selfcheck import run_startup_selfcheck
    runtime = initialize_runtime(require_cuda=True)
    modes = ("mixed", "f64") if args.precision == "both" else (args.precision,)
    checks = []
    for mode in modes:
        started = time.monotonic()
        check = run_startup_selfcheck(mode, inject_failure=args.inject_failure)
        check["startup_seconds"] = time.monotonic()-started
        checks.append(check)
    report = {"gate": "G1", "runtime": runtime, "checks": checks, "passed": all(c["passed"] for c in checks)}
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
