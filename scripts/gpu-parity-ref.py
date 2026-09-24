"""GPU 粗排 parity 测试的 Python 参考侧。

输入(JSON 文件):
  --bars        K 线 bars
  --candidates  候选 token 列表的列表
  --config      {timeframe, train_ratio, test_recent_bars, cost}
输出(JSON 到 stdout):
  {
    "feature_names": [...],
    "matrix": [[...]],           # 训练段特征矩阵 F×T(行主序)
    "periods": int, "cost": float, "train_len": int, "total_len": int,
    "entries": [                 # 与候选顺序一一对应
      {"valid": bool, "composite": float, "constant": bool}
    ]
  }

TS 参考实现(src/lib/mining/gpu/eval-core.ts)在相同输入上复算,断言
逐位/秩一致 —— 这是 WGSL 移植前的语义对拍(WGSL 再与 Python 直接对拍,
见 gpu-parity.test.ts 的适配器门控用例)。
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402
from factor_lab import execute  # noqa: E402
from factor_lab.features import feature_matrix  # noqa: E402
from factor_lab.scoring.evaluate import evaluate_factor  # noqa: E402
from factor_lab.scoring.periods import bars_per_year  # noqa: E402
from factor_lab.search import SearchConfig  # noqa: E402
from factor_lab.vm import is_constant, validate  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    def arg(name: str) -> str:
        return args[args.index(name) + 1]

    bars = json.loads(Path(arg("--bars")).read_text(encoding="utf-8"))
    candidates = json.loads(Path(arg("--candidates")).read_text(encoding="utf-8"))
    cfg_in = json.loads(Path(arg("--config")).read_text(encoding="utf-8"))

    payload = {
        "mode": "mine_features",
        "timeframe": cfg_in.get("timeframe", "1d"),
        "train_ratio": cfg_in.get("train_ratio", 0),
        "test_recent_bars": cfg_in.get("test_recent_bars", 0),
        "symbol": cfg_in.get("symbol", ""),
        "cost": cfg_in.get("cost"),
    }
    feats = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
    mat = np.array(feats["matrix"], dtype=float)
    periods = feats["periods"]
    cost = feats["cost"]
    train_len = feats["train_len"]
    train_close = np.array([float(b.get("close") or 0) for b in bars[:train_len]], dtype=float)

    cfg_fields = {k.name for k in __import__("dataclasses").fields(SearchConfig)}
    cfg_kwargs = {k: v for k, v in cfg_in.items() if k in cfg_fields and k != "cost"}

    entries = []
    for tokens in candidates:
        tokens = [int(t) for t in tokens]
        rejected = bool(tokens and validate(tokens))  # 恒正感染校验(GA 质量门,非求值错误)
        if not tokens:
            entries.append({"valid": False, "rejected": True, "constant": False, "composite": None})
            continue
        try:
            factor = execute(tokens, mat)
            if factor is None:
                entries.append({"valid": False, "rejected": rejected, "constant": False, "composite": None})
                continue
            const = bool(is_constant(factor))
            metrics = evaluate_factor(factor, train_close, cost=cost, periods=periods)
            comp = float(metrics["composite"]) - 0.02 * max(0, len(tokens) - 12)
            entries.append({
                "valid": True, "rejected": rejected, "constant": const, "composite": comp,
                "metrics": {
                    "ann_ret": float(metrics["ann_ret"]),
                    "sortino": float(metrics["sortino"]),
                    "calmar": float(metrics["calmar"]),
                    "ts_ic": float(metrics["ts_ic"]),
                    "symmetry": float(metrics["symmetry"]),
                    "turnover_q": float(metrics["turnover_q"]),
                    "oos_sortino": float(metrics["oos_sortino"]),
                    "consistency": float(metrics["consistency"]),
                },
            })
        except Exception:
            entries.append({"valid": False, "rejected": rejected, "constant": False, "composite": None})

    out = {
        "feature_names": feats["feature_names"],
        "matrix": feats["matrix"],
        "periods": periods,
        "cost": cost,
        "train_len": train_len,
        "total_len": len(bars),
        "entries": entries,
    }
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
