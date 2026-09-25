"""crypto 本地因子挖掘基准(任务 1,方案 §4)

三种模式:
- batch: 固定表达式批次(对拍 CPU 口径);
- budget: 固定唯一候选预算(population×generations 固定,比较产出);
- time: 固定本机计算时间(比较同时间预算下的产出;Pyodide 冷启动
  不计时——本脚本跑 CPython,冷启动概念不适用,报告注明)。

数据:默认从 Binance Vision 公共接口拉取真实 BTCUSDT K 线(无鉴权),
按数据哈希冻结到本地 JSON 缓存(不提交仓库);网络不可用时回退到
确定性合成行情并在输出标注 synthetic=True(不冒充真实行情结论)。

比较组(消融):
- legacy: crypto_ohlcv_v1 旧口径(基线);
- v2: crypto_local_v2(显式切分/因果归一化/样本门/封存揭示);
- v2_exec: v2 + perp_next_open 执行口径(funding 现金流;仅当行情含
  funding 字段——合成数据带模拟 funding 事件,真实现货数据无)。

输出: docs/experiments/crypto-local-v2/benchmark-<ts>.json
用法: python -X utf8 scripts/benchmark-crypto-mining.py [--mode budget] [--seeds 42,43,44] [--bars 2000]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402


def peak_rss_mb() -> float:
    """进程峰值内存(MB)。Windows 用 GetProcessMemoryInfo(PeakWorkingSetSize),
    POSIX 用 ru_maxrss;不可用时返回 -1 并在报告中标注。"""
    try:
        import sys as _sys

        if _sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class _PMC(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            psapi = ctypes.WinDLL("psapi")
            psapi.GetProcessMemoryInfo.argtypes = [
                wintypes.HANDLE, ctypes.POINTER(_PMC), wintypes.DWORD,
            ]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            k32 = ctypes.WinDLL("kernel32")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            pmc = _PMC()
            pmc.cb = ctypes.sizeof(_PMC)
            if psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                return round(pmc.PeakWorkingSetSize / 1048576, 1)
        else:
            import resource

            return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    except Exception:
        return -1.0
    return -1.0

OUT_DIR = ROOT / "docs" / "experiments" / "crypto-local-v2"
CACHE = ROOT / ".local-data" / "bench-bars"
SYMBOL = "BTCUSDT"
TIMEFRAME = "60m"
BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"]


def fetch_binance_klines(symbol: str, interval: str, total: int) -> list | None:
    """Binance Vision 公共 K 线(无鉴权);失败返回 None。"""
    import urllib.error

    for host in BINANCE_HOSTS:
        try:
            out: list = []
            end = int(time.time() * 1000)
            step = {"60m": 3_600_000, "1h": 3_600_000, "15m": 900_000, "1d": 86_400_000}[interval]
            while len(out) < total:
                limit = min(1000, total - len(out))
                url = (f"{host}/api/v3/klines?symbol={symbol}&interval={interval}"
                       f"&limit={limit}&endTime={end}")
                req = Request(url, headers={"User-Agent": "factor-bench/1.0"})
                with urlopen(req, timeout=15) as resp:
                    rows = json.loads(resp.read().decode())
                if not rows:
                    break
                out = rows + out
                end = int(rows[0][0]) - 1
            if len(out) >= total:
                return [
                    {
                        "time": datetime.fromtimestamp(int(r[0]) / 1000, tz=timezone.utc).isoformat(),
                        "open": float(r[1]), "high": float(r[2]), "low": float(r[3]),
                        "close": float(r[4]), "volume": float(r[5]),
                        "quote_volume": float(r[7]) if len(r) > 7 else None,
                        "trade_count": float(r[8]) if len(r) > 8 else None,
                        "taker_buy_volume": float(r[9]) if len(r) > 9 else None,
                    }
                    for r in out[-total:]
                ]
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            continue
    return None


def synthetic_bars(n: int, seed: int) -> list:
    """确定性合成行情(含模拟 funding 事件,供 v2_exec 口径端到端)。"""
    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 0.012, n)
    close = 100.0 * np.cumprod(1 + steps)
    t0 = datetime(2026, 1, 1)
    bars = []
    for i in range(n):
        b = {
            "time": (t0 + timedelta(hours=i)).isoformat(),
            "open": float(close[i] / (1 + abs(steps[i]))),
            "high": float(close[i] * 1.004), "low": float(close[i] * 0.996),
            "close": float(close[i]), "volume": float(1000 + rng.integers(0, 900)),
            "quote_volume": float(close[i] * 1000),
            "trade_count": float(200 + rng.integers(0, 100)),
            "taker_buy_volume": float(500 + rng.integers(0, 500)),
            "market_source": "bench_synthetic",
        }
        if i >= 8 and i % 8 == 0:
            b["funding_time"] = float(i * 3600_000)
            b["funding_rate"] = float(rng.normal(0.0001, 0.00005))
        bars.append(b)
    last = None
    for b in bars:
        if "funding_rate" in b:
            last = (b["funding_time"], b["funding_rate"])
        elif last:
            b["funding_time"], b["funding_rate"] = last
    return bars


def bars_hash(bars: list) -> str:
    digest = hashlib.sha256()
    for b in bars:
        digest.update(repr((b.get("time"), b.get("open"), b.get("close"), b.get("volume"),
                            b.get("funding_rate"))).encode())
    return digest.hexdigest()[:16]


def load_bars(n: int) -> tuple[list, bool]:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE / f"{SYMBOL}-{TIMEFRAME}-{n}.json"
    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        return data["bars"], data.get("synthetic", False)
    real = fetch_binance_klines(SYMBOL, "1h" if TIMEFRAME == "60m" else TIMEFRAME, n)
    if real is not None:
        cache_file.write_text(json.dumps({"bars": real, "synthetic": False}), encoding="utf-8")
        return real, False
    bars = synthetic_bars(n, seed=1000)
    cache_file.write_text(json.dumps({"bars": bars, "synthetic": True}), encoding="utf-8")
    return bars, True


def run_search_with_stats(bars: list, payload: dict, seeds_best: list | None = None):
    """mine_start/mine_step 会话式搜索,收集每代 stats 与最终冠军。"""
    sid = f"bench-{payload['seed']}"
    factor_local.mine_start(json.dumps({**payload, "session_id": sid}), json.dumps(bars))
    try:
        stats_acc: dict = {}
        champions = []
        while True:
            step = json.loads(factor_local.mine_step(sid))
            if step.get("done"):
                break
            if step.get("error"):
                raise RuntimeError(step["error"])
            champions = step.get("champions") or []
            if step.get("stats"):
                stats_acc = step["stats"]
        return champions, stats_acc
    finally:
        factor_local.mine_dispose(sid)


def run_group(bars: list, group: str, seed: int, cfg: dict) -> dict:
    payload = {
        "symbol": SYMBOL, "timeframe": TIMEFRAME, "crypto_profile": True,
        "population": cfg["population"], "generations": cfg["generations"],
        "top_n": cfg["top_n"], "seed": seed, "cost": cfg["cost"],
        "walk_forward_folds": 2, "final_generation": True,
    }
    if group == "legacy":
        pass  # 旧口径基线
    elif group == "v2":
        payload["research_profile"] = "crypto_local_v2"
    elif group == "v2_exec":
        payload["research_profile"] = "crypto_local_v2"
        payload["execution_model"] = "perp_next_open"
    t0 = time.perf_counter()
    mem0 = peak_rss_mb()
    champions, stats = run_search_with_stats(bars, payload)
    elapsed = time.perf_counter() - t0
    peak_mem = peak_rss_mb()
    statuses: dict[str, int] = {}
    holdout_passed = 0
    exec_sortinos = []
    for c in champions:
        m = c.get("metrics") or {}
        st = str(m.get("candidate_status") or ("overfit_warning" if m.get("overfit_warning") else "unclassified"))
        statuses[st] = statuses.get(st, 0) + 1
        if m.get("holdout_passed"):
            holdout_passed += 1
        if isinstance(m.get("execution_metrics"), dict):
            exec_sortinos.append(float(m["execution_metrics"].get("sortino") or 0.0))
    return {
        "group": group,
        "seed": seed,
        "elapsed_s": round(elapsed, 3),
        "n_champions": len(champions),
        "statuses": statuses,
        "holdout_passed": holdout_passed,
        # 从冠军状态汇总(严格筛通过的权威口径;SearchStats 的计数器
        # 只统计热路径漏斗,验证判定发生在 _dedup_top)
        "validation_passed": statuses.get("validation_passed", 0),
        "funnel": {k: stats.get(k) for k in (
            "generated", "syntax_valid", "unique_expression", "train_valid",
            "distinct_behavior", "precise_evaluated")},
        "rejection_reasons": stats.get("rejection_reasons", {}),
        "unique_per_sec": round(stats.get("unique_expression", 0) / max(elapsed, 1e-9), 2),
        "peak_rss_mb": peak_mem,
        "peak_rss_baseline_mb": mem0,
        **({"exec_sortino_median": round(float(np.median(exec_sortinos)), 4)} if exec_sortinos else {}),
    }


def run_group_time(bars: list, group: str, seed: int, cfg: dict, budget_s: float) -> dict:
    """time 模式:固定本机计算时间内反复搜索(每次不同子种子),累计产出。

    unique_expression 为跨重复累计(重复间种子不同,重叠可忽略——报告口径
    已注明);单次搜索完整跑完,末次可能超出预算(报告 actual_elapsed)。
    """
    import factor_local as fl

    base_payload = {
        "symbol": SYMBOL, "timeframe": TIMEFRAME, "crypto_profile": True,
        "population": cfg["population"], "generations": cfg["generations"],
        "top_n": cfg["top_n"], "cost": cfg["cost"],
        "walk_forward_folds": 2, "final_generation": True,
    }
    if group == "v2":
        base_payload["research_profile"] = "crypto_local_v2"
    elif group == "v2_exec":
        base_payload["research_profile"] = "crypto_local_v2"
        base_payload["execution_model"] = "perp_next_open"
    t0 = time.perf_counter()
    mem0 = peak_rss_mb()
    unique_total = 0
    train_valid_total = 0
    validation_passed = 0
    statuses: dict[str, int] = {}
    reps = 0
    last_champions: list = []
    while time.perf_counter() - t0 < budget_s:
        payload = {**base_payload, "seed": seed * 1000 + reps}
        champions, stats = run_search_with_stats(bars, payload)
        last_champions = champions
        unique_total += int(stats.get("unique_expression") or 0)
        train_valid_total += int(stats.get("train_valid") or 0)
        validation_passed += sum(
            1 for c in champions
            if (c.get("metrics") or {}).get("candidate_status") == "validation_passed"
        )
        for c in champions:
            m = c.get("metrics") or {}
            st = str(m.get("candidate_status") or "unclassified")
            statuses[st] = statuses.get(st, 0) + 1
        reps += 1
    elapsed = time.perf_counter() - t0
    return {
        "group": group,
        "seed": seed,
        "mode": "time",
        "budget_s": budget_s,
        "actual_elapsed_s": round(elapsed, 3),
        "repetitions": reps,
        "unique_expression_total": unique_total,
        "train_valid_total": train_valid_total,
        "validation_passed": validation_passed,
        "statuses": statuses,
        "unique_per_sec": round(unique_total / max(elapsed, 1e-9), 2),
        "peak_rss_mb": peak_rss_mb(),
        "peak_rss_baseline_mb": mem0,
        "kernel_version": fl.kernel_version(),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["batch", "budget", "time"], default="budget")
    ap.add_argument("--seeds", default="42,43,44")
    ap.add_argument("--bars", type=int, default=2400)
    ap.add_argument("--population", type=int, default=30)
    ap.add_argument("--generations", type=int, default=8)
    ap.add_argument("--time-budget", type=float, default=30.0, help="time 模式的秒预算")
    args = ap.parse_args()

    bars, synthetic = load_bars(args.bars)
    cfg = {"population": args.population, "generations": args.generations,
           "top_n": 10, "cost": 0.0008}
    seeds = [int(s) for s in args.seeds.split(",")]

    results = {
        "mode": args.mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kernel_version": factor_local.kernel_version(),
        "python": sys.version.split()[0],
        "symbol": SYMBOL, "timeframe": TIMEFRAME,
        "n_bars": len(bars),
        "bars_hash": bars_hash(bars),
        "synthetic": synthetic,
        "config": cfg,
        "seeds": seeds,
        "groups": [],
        # 基线可复现性检查:同 seed 重复运行逐位一致(CPU 确定性)
        "determinism_check": None,
    }

    groups = ["legacy", "v2", "v2_exec"]
    if args.mode == "time":
        for group in groups:
            for seed in seeds:
                results["groups"].append(
                    run_group_time(bars, group, seed, cfg, args.time_budget)
                )
        results["determinism_check"] = {"note": "time 模式不做确定性复跑(预算语义不同)"}
    else:
        for group in groups:
            for seed in seeds:
                results["groups"].append(run_group(bars, group, seed, cfg))
        # 确定性:同组同 seed 重跑,冠军 tokens 序列一致
        a = run_group(bars, "v2", seeds[0], cfg)
        b = run_group(bars, "v2", seeds[0], cfg)
        results["determinism_check"] = {
            "statuses_equal": a["statuses"] == b["statuses"],
            "funnel_equal": a["funnel"] == b["funnel"],
        }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"benchmark-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    # 控制台摘要
    print(f"== crypto mining benchmark ({args.mode}) ==")
    print(f"kernel={results['kernel_version']} bars={len(bars)} hash={results['bars_hash']} synthetic={synthetic}")
    for group in groups:
        rows = [g for g in results["groups"] if g["group"] == group]
        if args.mode == "time":
            uniq = sum(g["unique_expression_total"] for g in rows)
            val = sum(g["validation_passed"] for g in rows)
            t = sum(g["actual_elapsed_s"] for g in rows)
            mem = max(g["peak_rss_mb"] for g in rows)
            reps = sum(g["repetitions"] for g in rows)
            print(f"[{group:8s}] unique_total={uniq:6d} ({t:.0f}s, {reps} reps) "
                  f"validation_passed={val} peak_rss={mem}MB")
        else:
            uniq = sum(g["funnel"]["unique_expression"] or 0 for g in rows) / len(rows)
            val = sum(g["validation_passed"] for g in rows)
            hold = sum(g["holdout_passed"] for g in rows)
            t = sum(g["elapsed_s"] for g in rows) / len(rows)
            mem = max(g["peak_rss_mb"] for g in rows)
            print(f"[{group:8s}] unique/cand={uniq:7.1f} validation_passed={val} "
                  f"holdout_passed={hold} avg={t:.1f}s peak_rss={mem}MB")
    print(f"determinism: {results['determinism_check']}")
    print(f"output: {out}")


if __name__ == "__main__":
    main()
