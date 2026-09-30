"""在指定 worktree 上直接对比 native eval_shards vs pykernel evaluate_factor
（不经过 G2 参考），判定 ETH/15m 候选 [48,6,66,42,71,68,111,73] 的
composite 分歧是否在 HEAD（未改动引擎）就已存在。
用法: python scripts/shortline-diag-mixed.py <worktree-root>
"""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(root / "native-engine"), str(root / "public" / "pykernel")]

KEY = [48, 6, 66, 42, 71, 68, 111, 73]
SUITE = Path(r"D:\pyobj\AI Trading Desktop\.local-data\native-gpu-g2")
config = json.loads((SUITE / "ETHUSDT-15m.config.json").read_text())
bars = json.loads((SUITE / "ETHUSDT-15m.bars.json").read_bytes())

from engine.runtime import initialize_runtime
from engine.session import NativeSession

runtime = initialize_runtime("mixed", require_cuda=True)
session = NativeSession("diag", runtime, "mixed")
try:
    session.load_records(bars, {"max_bars": 100_000})
    session.prepare_features(config)
    session.rank_shards([KEY])
    rows = session.eval_shards([KEY])
    native_comp = rows[0]["metrics"]["composite"]
finally:
    session.dispose()

# CPU 权威（同 worktree 的 pykernel，镜像 reference 页的评估路径）
from factor_lab.features import feature_matrix
from factor_lab.vm import execute
from factor_lab.scoring.evaluate import evaluate_factor
from factor_lab.scoring.periods import bars_per_year
from factor_lab.market import prepare_bars

prepared = prepare_bars(config, bars)
mat = feature_matrix(prepared)
factor = execute(KEY, mat, 250)
periods = bars_per_year(prepared, config["timeframe"])
close = [float(b.get("close") or 0) for b in prepared]
metrics = evaluate_factor(factor, close, config["cost"], periods)
cpu_comp = metrics["composite"]

err = abs(native_comp - cpu_comp) / abs(cpu_comp) if cpu_comp else 0
print(json.dumps({
    "worktree": str(root), "tokens": KEY,
    "native_composite": native_comp, "cpu_composite": cpu_comp,
    "relative_error": err, "exceeds_1e-9": bool(err >= 1e-9),
}))
