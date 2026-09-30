"""全周期验证套件编排:并行跑 (symbol × timeframe × 配置) 组合。

每个 case = 内核 CPU 产品路径 search() + 引擎合格门(见 factor-verify-run.py)。
输出 .local-data/factor-verify/summary.jsonl 与控制台汇总表。
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
OUT_DIR = ROOT / ".local-data" / "factor-verify"


def run_one(job: dict) -> dict:
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "factor_verify_run", ROOT / "scripts" / "factor-verify-run.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["factor_verify_run"] = module
    spec.loader.exec_module(module)
    try:
        result = module.run_case(job["symbol"], job["tf"], job["population"],
                                job["generations"], job.get("seeds", False),
                                job.get("folds", 3), job.get("label_span", 0))
        result["job"] = job
        return result
    except Exception as e:  # noqa: BLE001 - 单 case 失败不拖垮套件
        return {"job": job, "error": f"{type(e).__name__}: {e}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--population", type=int, default=600)
    parser.add_argument("--generations", type=int, default=40)
    parser.add_argument("--controls", action="store_true", help="附带无种子对照组")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--symbols", nargs="*", default=None, help="只跑这些币种")
    parser.add_argument("--timeframes", nargs="*", default=None, help="只跑这些周期")
    parser.add_argument("--label-span", type=int, default=0)
    args = parser.parse_args()

    jobs = []
    for bars in sorted(OUT_DIR.glob("*.bars.json")):
        symbol, tf = bars.name[: -len(".bars.json")].rsplit("-", 1)
        if args.symbols and symbol not in args.symbols:
            continue
        if args.timeframes and tf not in args.timeframes:
            continue
        jobs.append({"symbol": symbol, "tf": tf,
                     "population": args.population, "generations": args.generations,
                     "seeds": True, **({"label_span": args.label_span} if args.label_span else {})})
        if args.controls and symbol in ("BTCUSDT", "ETHUSDT"):
            jobs.append({"symbol": symbol, "tf": tf,
                         "population": args.population, "generations": args.generations,
                         "seeds": False})
    if not jobs:
        print("no bars found")
        return 1
    print(f"{len(jobs)} jobs, workers={args.workers}", flush=True)
    summary_path = OUT_DIR / "summary.jsonl"
    started = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as pool, \
            summary_path.open("a", encoding="utf-8") as handle:
        futures = {pool.submit(run_one, job): job for job in jobs}
        for future in as_completed(futures):
            result = future.result()
            handle.write(json.dumps(result, ensure_ascii=False, default=str) + "\n")
            handle.flush()
            if "error" in result:
                print(f"[ERR] {result['job']['symbol']} {result['job']['tf']} seeds={result['job'].get('seeds')}: {result['error']}", flush=True)
            else:
                print(f"[OK ] {result['symbol']} {result['timeframe']} seeds={int(result['seeds'])}: "
                      f"qualified={result['qualified']}/{result['champions_total']} "
                      f"rejects={result['rejected']} {result['elapsed_s']}s "
                      f"reasons={result['reasons']}", flush=True)
    print(f"done in {time.time() - started:.0f}s -> {summary_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
