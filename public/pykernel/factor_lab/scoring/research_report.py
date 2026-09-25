"""搜索统计与试验账本(crypto_local_v2,任务 1/10,方案 §4/§13.1)

背景:搜索只回传最终冠军,「多少候选被什么原因淘汰」不可追溯——
相同预算下的产出比较无法复现。本模块在搜索热路径旁路收集漏斗计数:

    generated → syntax_valid → unique_expression → train_valid
            → distinct_behavior → validation_passed → holdout_passed

每级记录主淘汰原因直方图(非法式/常数/缺失/同质/成本失败/WF 失败等)。

试验账本纪律(方案 §13.1):
- population×generations 是预算近似值,不是精确独立试验数;total_trials
  与 unique_trials 分开报告;
- pbo_proxy 展示名"验证失败率"(被验证候选失败比例),不是正式 PBO;
- DSR 保留为近似诊断(零假设标准误),不写成"盈利概率"。

计数器对数值零侵入:搜索结果的每一个数字仍出自 evaluate_factor/
_dedup_top,本模块只做旁路统计。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SearchStats:
    """漏斗计数 + 淘汰原因直方图(可 JSON 序列化)。"""

    generated: int = 0
    syntax_valid: int = 0
    unique_expression: int = 0
    train_valid: int = 0
    distinct_behavior: int = 0
    precise_evaluated: int = 0
    validation_passed: int = 0
    holdout_passed: int = 0
    holdout_revealed: int = 0
    rejection_reasons: dict[str, int] = field(default_factory=dict)
    _seen_tokens: set[tuple[int, ...]] = field(default_factory=set)
    _seen_fp: set[tuple] = field(default_factory=set)

    def note_generated(self) -> None:
        self.generated += 1

    def note_invalid_syntax(self, reason: str = "invalid_syntax") -> None:
        self.rejection_reasons[reason] = self.rejection_reasons.get(reason, 0) + 1

    def note_syntax_valid(self) -> None:
        self.syntax_valid += 1

    def note_execution(
        self, tokens: list[int], ok: bool, reason: str | None, metrics: dict | None
    ) -> None:
        """一次候选执行的旁路记录(不计入任何评估路径)。"""
        key = tuple(int(t) for t in tokens)
        if key not in self._seen_tokens:
            self._seen_tokens.add(key)
            self.unique_expression += 1
        if not ok:
            self.rejection_reasons[reason or "not_train_valid"] = (
                self.rejection_reasons.get(reason or "not_train_valid", 0) + 1
            )
            return
        self.train_valid += 1
        self.precise_evaluated += 1
        if metrics:
            fp = self._fp(metrics)
            if fp is not None and fp not in self._seen_fp:
                self._seen_fp.add(fp)
                self.distinct_behavior += 1

    @staticmethod
    def _fp(metrics: dict) -> tuple | None:
        try:
            return (
                round(float(metrics["ann_ret"]), 6),
                round(float(metrics["sortino"]), 6),
                round(float(metrics["ts_ic"]), 6),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def note_validation(self, passed: bool, reason: str | None = None) -> None:
        if passed:
            self.validation_passed += 1
        else:
            r = reason or "validation_failed"
            self.rejection_reasons[r] = self.rejection_reasons.get(r, 0) + 1

    def note_holdout(self, passed: bool) -> None:
        self.holdout_revealed += 1
        if passed:
            self.holdout_passed += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "generated": self.generated,
            "syntax_valid": self.syntax_valid,
            "unique_expression": self.unique_expression,
            "train_valid": self.train_valid,
            "distinct_behavior": self.distinct_behavior,
            "precise_evaluated": self.precise_evaluated,
            "validation_passed": self.validation_passed,
            "holdout_passed": self.holdout_passed,
            "holdout_revealed": self.holdout_revealed,
            "rejection_reasons": dict(self.rejection_reasons),
        }

    @staticmethod
    def summarize(champions: list[dict]) -> dict[str, Any]:
        """从最终冠军 metrics 汇总研究状态(报告口径,方案 §13.2)。"""
        statuses: dict[str, int] = {}
        for c in champions:
            m = c.get("metrics") or {}
            st = str(m.get("candidate_status") or (
                "overfit_warning" if m.get("overfit_warning") else "unclassified"
            ))
            statuses[st] = statuses.get(st, 0) + 1
        return {
            "champion_statuses": statuses,
            "insufficient_samples": sum(
                1 for c in champions if (c.get("metrics") or {}).get("insufficient_samples")
            ),
            "n_champions": len(champions),
        }
