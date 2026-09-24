"""P2-12 配套守卫:中文文案表必须覆盖全部注册算子/特征。

防止后续扩容再漏配(文档建议:test_ops_text_coverage)。
用法: python scripts/verify-kernel-text.py
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

from factor_lab.express import _FEAT_TEXT, _OP_TEXT  # noqa: E402
from factor_lab.features import FEATURE_NAMES  # noqa: E402
from factor_lab.ops import OPS_NAMES  # noqa: E402


def main() -> int:
    missing_ops = sorted(set(OPS_NAMES) - set(_OP_TEXT))
    missing_feats = sorted(set(FEATURE_NAMES) - set(_FEAT_TEXT))
    if missing_ops:
        print(f"[FAIL] 算子缺中文文案: {missing_ops}")
        return 1
    if missing_feats:
        print(f"[FAIL] 特征缺中文文案: {missing_feats}")
        return 1
    print(f"[OK] {len(OPS_NAMES)} 个算子 / {len(FEATURE_NAMES)} 个特征文案全覆盖")
    return 0


if __name__ == "__main__":
    sys.exit(main())
