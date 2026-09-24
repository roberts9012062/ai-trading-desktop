"""发布前清单第 4 步工具:新旧内核口径对照。

对给定 (bars, factor tokens),用当前工作区内核与指定 git 提交的旧内核
各算一遍指标,输出对照表(ann_ret/sortino/calmar/turnover_q/composite)
与仓位序列差异率 mean(pos_new != pos_old)。批次二发布时,对第 3 步盘点
出的每个实盘因子跑一次本脚本,结果交项目负责人决策(第 5 步人工关口)。

用法:
  python scripts/caliber-diff.py --bars bars.json --tokens tokens.json \
      --old <git-ref> [--periods 243] [--cost 0.0003]
  例: --old 2186ab9  (批次二之前的内核)
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

INNER = """
import json, sys
sys.path.insert(0, r"{kernel_dir}")
import numpy as np
from factor_lab.features import feature_matrix
from factor_lab.scoring.evaluate import evaluate_factor, position_from_factor
from factor_lab.vm import execute

bars = json.load(open(r"{bars_path}"))
tokens = json.load(open(r"{tokens_path}"))
mat = feature_matrix(bars)
factor = execute(tokens, mat)
if factor is None:
    print(json.dumps(None))
    raise SystemExit(0)
close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
m = evaluate_factor(factor, close, cost={cost}, periods={periods})
pos = position_from_factor(factor)
print(json.dumps({{
    "metrics": {{k: float(v) for k, v in m.items() if isinstance(v, (int, float))}},
    "pos": [round(float(p), 6) for p in pos],
}}))
"""


def run_kernel(kernel_dir: str, bars_path: str, tokens_path: str, cost: float, periods: int) -> dict | None:
    code = INNER.format(
        kernel_dir=kernel_dir, bars_path=bars_path, tokens_path=tokens_path,
        cost=cost, periods=periods,
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT
    )
    if proc.returncode != 0:
        raise RuntimeError(f"内核子进程失败:\n{proc.stderr[-2000:]}")
    return json.loads(proc.stdout)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bars", required=True, help="bars JSON 文件")
    ap.add_argument("--tokens", required=True, help="factor tokens JSON 文件(如 [0,65])")
    ap.add_argument("--old", required=True, help="旧内核所在 git ref(如 2186ab9)")
    ap.add_argument("--periods", type=int, default=243, help="年化基数(默认日线 243)")
    ap.add_argument("--cost", type=float, default=0.0003, help="单位换手成本率")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        # 旧内核:从 git 提交导出
        old_dir = Path(td) / "old"
        old_dir.mkdir()
        archive = subprocess.run(
            ["git", "archive", args.old, "public/pykernel"],
            capture_output=True, cwd=ROOT,
        )
        if archive.returncode != 0:
            print(f"git archive 失败: {archive.stderr.decode()[:500]}")
            return 1
        subprocess.run(["tar", "-x", "-C", str(old_dir)], input=archive.stdout, check=True)
        old_kernel = str(old_dir / "public" / "pykernel")

        old = run_kernel(old_kernel, args.bars, args.tokens, args.cost, args.periods)
        new = run_kernel(str(ROOT / "public" / "pykernel"), args.bars, args.tokens, args.cost, args.periods)

    if new is None or old is None:
        print(f"因子在新/旧内核下无法执行: old={old is not None} new={new is not None}")
        return 1

    pos_diff = sum(1 for a, b in zip(old["pos"], new["pos"]) if a != b) / len(old["pos"])

    keys = ["ann_ret", "sortino", "calmar", "ts_ic", "turnover_q", "oos_sortino", "oos_mult", "composite"]
    print(f"{'指标':<14}{'旧内核':>14}{'新内核':>14}{'差异':>14}")
    for k in keys:
        o = old["metrics"].get(k)
        n = new["metrics"].get(k)
        if o is None or n is None:
            continue
        print(f"{k:<14}{o:>14.6f}{n:>14.6f}{n - o:>14.6f}")
    print(f"\n仓位序列差异率 mean(pos_new != pos_old) = {pos_diff:.4%}")
    print("注:指标变差或仓位差异率超阈值(建议 5%)的任务,需明确决定停用/重新验收/维持(清单第 5 步)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
