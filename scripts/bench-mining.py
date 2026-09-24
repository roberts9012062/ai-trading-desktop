"""因子挖掘基准评测 —— 用"从未参与挖掘的封存期"衡量冠军真实质量

问题:挖掘内部的测试段/WF 都参与了冠军遴选,报出来的数字天然偏乐观,
不能用来比较算法好坏。本脚本对每个品种把最近 --sealed 比例的 K 线整段
封存(不传给 search),挖掘结束后才在封存期上评估冠军,A/B 比较各配置:

  baseline      原内核(与服务端逐位一致)
  selection_v2  行为去重先行 + 验证/封存三段切分 + DSR
  v2_full       selection_v2 + evolve_v2(点/收缩变异、克隆降权、零平台细分、停滞重启)
  v2_live       v2_full + 实盘离散口径门(开仓阈值 0.3)

数据:scripts/export-bench-bars.py 导出的 scripts/.bench-data/<品种>_1d.json。
用法:
  python scripts/bench-mining.py                       # 默认 300×30、2 个种子
  python scripts/bench-mining.py --pop 100 --gen 10 --seeds 1 --symbols rb,cu   # 快速
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KERNEL = ROOT / "public" / "pykernel"
DATA_DIR = ROOT / "scripts" / ".bench-data"

CONFIGS: dict[str, dict] = {
    "baseline": {},
    "selection_v2": {"selection_v2": True},
    "v2_full": {"selection_v2": True, "evolve_v2": True},
    "v2_live": {"selection_v2": True, "evolve_v2": True, "live_entry_gate": 0.3},
}


def _run_one(job: dict) -> dict:
    sys.path.insert(0, str(KERNEL))
    import factor_local
    from factor_lab.scoring.portfolio import evaluate_portfolio
    from factor_lab.scoring.walk_forward import evaluate_on_slice
    from factor_lab.search import SearchConfig, search

    bars_all = json.loads((DATA_DIR / f"{job['symbol']}_1d.json").read_text(encoding="utf-8"))
    bars_all = bars_all[-job["bars"] :]
    n_sealed = int(len(bars_all) * job["sealed"])
    search_bars = bars_all[: len(bars_all) - n_sealed]
    lo = len(search_bars)
    cost = factor_local.resolve_cost(job["symbol"], search_bars, None)
    cfg = SearchConfig(
        population=job["pop"],
        generations=job["gen"],
        max_depth=job["depth"],
        top_n=10,
        seed=job["seed"],
        cost=cost,
        train_ratio=0.7,
        walk_forward_folds=3,
        islands=job["islands"],
        **CONFIGS[job["config"]],
    )
    t0 = time.time()
    champions = search(search_bars, "1d", cfg)
    elapsed = time.time() - t0

    rows = []
    for c in champions:
        m = c.metrics
        sealed = evaluate_on_slice(c.tokens, bars_all, lo, len(bars_all), "1d", cost)
        rows.append(
            {
                "text": c.text,
                "fallback": bool(m.get("overfit_warning")),
                "sealed_sortino": sealed["sortino"] if sealed else None,
                "sealed_ann": sealed["ann_ret"] if sealed else None,
                # 挖掘自己报告的样本外口径:v2 为封存段,原版为测试段
                "reported_sortino": (m.get("holdout_metrics") or m.get("test_metrics") or {}).get("sortino"),
                "dsr": m.get("dsr"),
            }
        )
    usable = [c.tokens for c, r in zip(champions, rows) if not r["fallback"]]
    port = None
    if len(usable) >= 2:
        p = evaluate_portfolio(bars_all, "1d", usable, cost, eval_from=lo)
        port = p["equal"]["sortino"] if p else None
    return {**job, "elapsed": elapsed, "champions": rows, "portfolio_sealed_sortino": port}


def _mean(xs: list[float]) -> float | None:
    return statistics.fmean(xs) if xs else None


def _fmt(v: float | None, pct: bool = False) -> str:
    if v is None:
        return "   -  "
    return f"{v * 100:5.1f}%" if pct else f"{v:6.3f}"


def summarize(results: list[dict]) -> None:
    print("\n=== 封存期(挖掘全程不可见)评估 ===")
    print(
        f"{'配置':<13}{'可用冠军/次':>9}{'兜底率':>8}{'封存sortino均值':>14}{'中位':>8}"
        f"{'胜率':>8}{'Top1均值':>9}{'等权组合':>9}{'报告-封存':>10}{'耗时s':>7}"
    )
    by_cfg: dict[str, list[dict]] = {}
    for r in results:
        by_cfg.setdefault(r["config"], []).append(r)
    for name in CONFIGS:
        runs = by_cfg.get(name) or []
        if not runs:
            continue
        usable = [c for r in runs for c in r["champions"] if not c["fallback"] and c["sealed_sortino"] is not None]
        sealed = [c["sealed_sortino"] for c in usable]
        top1 = [
            r["champions"][0]["sealed_sortino"]
            for r in runs
            if r["champions"] and not r["champions"][0]["fallback"] and r["champions"][0]["sealed_sortino"] is not None
        ]
        ports = [r["portfolio_sealed_sortino"] for r in runs if r["portfolio_sealed_sortino"] is not None]
        gap = [c["reported_sortino"] - c["sealed_sortino"] for c in usable if c["reported_sortino"] is not None]
        fallback_rate = sum(1 for r in runs if any(c["fallback"] for c in r["champions"])) / len(runs)
        print(
            f"{name:<13}{len(usable) / len(runs):>9.1f}{_fmt(fallback_rate, True):>8}"
            f"{_fmt(_mean(sealed)):>14}{_fmt(statistics.median(sealed) if sealed else None):>8}"
            f"{_fmt(sum(1 for s in sealed if s > 0) / len(sealed) if sealed else None, True):>8}"
            f"{_fmt(_mean(top1)):>9}{_fmt(_mean(ports)):>9}{_fmt(_mean(gap)):>10}"
            f"{_mean([r['elapsed'] for r in runs]) or 0:>7.1f}"
        )
    # 配对比较:同品种同种子,各配置可用冠军封存 sortino 均值 vs baseline
    base = {(r["symbol"], r["seed"]): r for r in by_cfg.get("baseline", [])}

    def run_mean(r: dict) -> float | None:
        xs = [c["sealed_sortino"] for c in r["champions"] if not c["fallback"] and c["sealed_sortino"] is not None]
        return _mean(xs)

    print("\n=== 配对比较(同品种同种子,可用冠军封存 sortino 均值) ===")
    for name in CONFIGS:
        if name == "baseline":
            continue
        wins = losses = 0
        diffs = []
        for r in by_cfg.get(name) or []:
            b = base.get((r["symbol"], r["seed"]))
            if not b:
                continue
            x, y = run_mean(r), run_mean(b)
            if x is None or y is None:
                continue
            diffs.append(x - y)
            wins += x > y
            losses += x < y
        print(f"{name:<13} 胜 {wins} / 负 {losses}  平均差 {_fmt(_mean(diffs))}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default="all")
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--pop", type=int, default=300)
    ap.add_argument("--gen", type=int, default=30)
    ap.add_argument("--depth", type=int, default=4)
    ap.add_argument("--islands", type=int, default=2)
    ap.add_argument("--seeds", type=int, default=2)
    ap.add_argument("--bars", type=int, default=2400, help="每品种取最近多少根")
    ap.add_argument("--sealed", type=float, default=0.2, help="封存比例")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--out", default=str(DATA_DIR / "bench-results.json"))
    args = ap.parse_args()

    if args.symbols == "all":
        symbols = sorted(p.name.split("_")[0] for p in DATA_DIR.glob("*_1d.json"))
    else:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    usable = []
    for s in symbols:
        n = len(json.loads((DATA_DIR / f"{s}_1d.json").read_text(encoding="utf-8")))
        if n >= args.bars:
            usable.append(s)
        else:
            print(f"跳过 {s}:仅 {n} 根 < {args.bars}")
    jobs = [
        dict(symbol=s, config=c, seed=1000 + k, pop=args.pop, gen=args.gen, depth=args.depth,
             islands=args.islands, bars=args.bars, sealed=args.sealed)
        for s in usable
        for c in args.configs.split(",")
        for k in range(args.seeds)
    ]
    print(f"{len(usable)} 品种 × {len(args.configs.split(','))} 配置 × {args.seeds} 种子 = {len(jobs)} 次挖掘,"
          f"{args.workers} 进程,每次 {args.pop}×{args.gen}")
    results = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(_run_one, j) for j in jobs]
        for i, f in enumerate(as_completed(futs), 1):
            r = f.result()
            results.append(r)
            print(f"[{i}/{len(jobs)}] {r['symbol']:>3} {r['config']:<13} seed={r['seed']} "
                  f"{r['elapsed']:.0f}s 冠军 {len(r['champions'])}", flush=True)
    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"总耗时 {time.time() - t0:.0f}s,明细 → {args.out}")
    summarize(results)


if __name__ == "__main__":
    main()
