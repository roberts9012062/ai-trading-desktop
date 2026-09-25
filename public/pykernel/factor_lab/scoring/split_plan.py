"""SplitPlan —— 显式区间边界的训练/验证/封存切分(crypto_local_v2)

旧路径(walk_forward.split_bars / search 内联切分)的问题:
- 任意一段不足 MIN_TEST_BARS 时静默退化成"全量训练",下游继续出结果,
  短样本失去验证却显示搜索"成功"(方案 2.1-B);
- walk_forward_eval 用 test_end <= train_len 一个布尔值判定整折是否在
  训练区,跨越训练边界的折被整体计入 OOS(方案 2.1-A);
- 切分比例在多处各自 round,单因子/组合/跨币口径可能漂移。

本模块把切分变成一次性解析、随结果冻结的不可变对象:
- 60% 训练 / 20% 验证 / 20% 封存(默认,仅样本条件满足时启用);
- 记录索引边界、UTC 时间边界、标签跨度、预热消耗与每段可评估条数;
- 样本不足时返回 sufficient=False + 具体缺口,调用方据此走"探索"路径,
  不得输出通过样本外验证的标记;
- 验证折只在 [train_end, validation_end) 内切分:历史上下文可以延伸到
  训练区(warmup),计分样本不可以 —— 这是 fix A 的结构性版本。

纯函数、无状态;所有入口(单因子/组合/跨币/成本压力)复用同一对象,
不得各自重新 round 比例。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 预注册默认门槛(方案 5.3):工程底线,不根据结果临时调整。
# 验证/封存每段至少 120 个有效收益样本;训练至少 500。
MIN_VALIDATION_BARS = 120
MIN_HOLDOUT_BARS = 120
MIN_TRAIN_BARS = 500
# 验证折每折至少 60 个计分样本(折在验证段内切,段级门槛仍由上面把守)
MIN_FOLD_BARS = 60
# 建议的日历跨度门槛(自然日):验证/封存各至少 30 天才作正式验证
MIN_VALIDATION_DAYS = 30
MIN_HOLDOUT_DAYS = 30


@dataclass(frozen=True)
class SplitPlan:
    """不可变切分计划。索引均指向全量 bars:[lo, hi) 左闭右开。"""

    n: int
    train_start: int
    train_end: int            # 训练区 [train_start, train_end)
    validation_end: int       # 验证区 [train_end, validation_end)
    holdout_end: int          # 封存区 [validation_end, holdout_end);未封存时 == validation_end
    label_span: int           # 收益标签需要的未来 bar 数(末尾不足的 bar 不计分)
    warmup: int               # 特征/算子预热 bar 数(上下文允许延伸进训练区)
    train_eval_start: int     # 训练区首个可计分 bar(预热 + 标签清除后)
    validation_score_start: int   # 验证区首个可计分 bar(标签清除后)
    holdout_score_start: int      # 封存区首个可计分 bar(标签清除后)
    train_time_start: str | None = None
    train_time_end: str | None = None
    validation_time_end: str | None = None
    holdout_time_end: str | None = None
    sufficient: bool = False
    insufficiency_reasons: tuple[str, ...] = ()
    # 末尾标签不完整的 bar 数(在 holdout 尾部,不补 0 参加统计)
    tail_unclear_bars: int = 0

    @property
    def has_holdout(self) -> bool:
        return self.holdout_end > self.validation_end

    def to_summary(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "train": [self.train_start, self.train_end],
            "validation": [self.train_end, self.validation_end],
            "holdout": [self.validation_end, self.holdout_end],
            "train_eval_bars": max(0, self.train_end - self.train_eval_start),
            "validation_eval_bars": max(
                0, self.validation_end - self.validation_score_start - self.tail_unclear_bars
            ),
            "holdout_eval_bars": max(
                0, self.holdout_end - self.holdout_score_start - self.tail_unclear_bars
            ),
            "label_span": self.label_span,
            "warmup": self.warmup,
            "sufficient": self.sufficient,
            "insufficiency_reasons": list(self.insufficiency_reasons),
            "time": {
                "train_start": self.train_time_start,
                "train_end": self.train_time_end,
                "validation_end": self.validation_time_end,
                "holdout_end": self.holdout_time_end,
            },
        }


def build_split_plan(
    n: int,
    *,
    train_ratio: float = 0.6,
    validation_ratio: float = 0.2,
    label_span: int = 1,
    warmup: int = 250,
    bars: list[dict[str, Any]] | None = None,
    require_calendar_days: bool = True,
) -> SplitPlan:
    """按显式比例构建 60/20/20 切分;样本不足时不切并给出缺口清单。

    label_span: 收益标签跨越的 bar 数(h 根预测/次根开盘成交按实际跨度传入)。
    末尾 label_span-1 根没有完整收益标签,不补 0、不计分(tail_unclear_bars)。
    验证/封存段的计分起点 = 段首(上下文 warmup 允许从训练区取)。
    """
    ratios = (train_ratio, validation_ratio, 1.0 - train_ratio - validation_ratio)
    if any(r <= 0 for r in ratios):
        raise ValueError(f"split ratios must be positive: {ratios}")
    n_train = int(round(n * train_ratio))
    n_val = int(round(n * validation_ratio))
    n_hold = n - n_train - n_val
    train_end = n_train
    validation_end = n_train + n_val
    holdout_end = n
    tail = max(0, label_span - 1)
    reasons: list[str] = []
    if n_train < MIN_TRAIN_BARS:
        reasons.append(f"train={n_train} < {MIN_TRAIN_BARS}")
    if n_val - tail < MIN_VALIDATION_BARS:
        reasons.append(f"validation={n_val - tail} < {MIN_VALIDATION_BARS}")
    if n_hold - tail < MIN_HOLDOUT_BARS:
        reasons.append(f"holdout={n_hold - tail} < {MIN_HOLDOUT_BARS}")
    if require_calendar_days and bars is not None:
        from datetime import datetime

        def _span_days(lo: int, hi: int) -> float:
            try:
                a = datetime.fromisoformat(str(bars[lo].get("time") or "")[:19])
                b = datetime.fromisoformat(str(bars[hi - 1].get("time") or "")[:19])
                # 段跨度含末根 bar 的完整区间(首根开到末根收),不足两根按 0
                gaps = []
                for k in range(lo + 1, min(hi, lo + 6)):
                    g = datetime.fromisoformat(str(bars[k].get("time") or "")[:19]) - datetime.fromisoformat(str(bars[k - 1].get("time") or "")[:19])
                    if g.total_seconds() > 0:
                        gaps.append(g)
                interval = min(gaps, key=lambda g: g.total_seconds()) if gaps else (b - a) / max(hi - lo - 1, 1)
                return ((b - a) + interval).total_seconds() / 86400.0
            except (ValueError, IndexError, ZeroDivisionError):
                return 0.0

        val_days = _span_days(train_end, validation_end)
        hold_days = _span_days(validation_end, holdout_end)
        if val_days < MIN_VALIDATION_DAYS:
            reasons.append(f"validation_span={val_days:.0f}d < {MIN_VALIDATION_DAYS}d")
        if hold_days < MIN_HOLDOUT_DAYS:
            reasons.append(f"holdout_span={hold_days:.0f}d < {MIN_HOLDOUT_DAYS}d")

    def _time(i: int) -> str | None:
        return str(bars[i].get("time")) if bars and 0 <= i < len(bars) else None

    return SplitPlan(
        n=n,
        train_start=0,
        train_end=train_end,
        validation_end=validation_end,
        holdout_end=holdout_end,
        label_span=label_span,
        warmup=warmup,
        train_eval_start=min(warmup, train_end),
        validation_score_start=train_end,
        holdout_score_start=validation_end,
        train_time_start=_time(0),
        train_time_end=_time(train_end - 1),
        validation_time_end=_time(validation_end - 1),
        holdout_time_end=_time(holdout_end - 1),
        sufficient=not reasons,
        insufficiency_reasons=tuple(reasons),
        tail_unclear_bars=tail,
    )


def plan_validation_folds(
    plan: SplitPlan,
    n_folds: int,
    min_fold_bars: int = MIN_FOLD_BARS,
) -> list[tuple[int, int]] | None:
    """验证折切分:只在 [train_end, validation_end) 计分内等分。

    每折返回 (score_start, score_end)。历史上下文(context_start)由评估层
    按 warmup 向前延伸,允许进入训练区;计分样本不可以。
    折数过多导致每折不足 min_fold_bars 时返回 None(样本不足,不得降格)。
    """
    if n_folds <= 0:
        return None
    lo, hi = plan.validation_score_start, plan.validation_end
    usable = hi - lo - plan.tail_unclear_bars
    if usable < n_folds * min_fold_bars:
        return None
    seg = usable // n_folds
    folds: list[tuple[int, int]] = []
    for i in range(n_folds):
        a = lo + i * seg
        b = lo + (i + 1) * seg if i < n_folds - 1 else hi - plan.tail_unclear_bars
        folds.append((a, b))
    return folds


def boundary_folds_in_train(
    folds: list[tuple[int, int]], train_end: int
) -> list[bool]:
    """逐折判定计分区间是否与训练区重叠(fix A 的区间交集版)。

    旧实现 test_end <= train_len 才标 in_train:跨训练边界的折
    (test_start < train_len < test_end)被整体计入 OOS。正确语义:
    计分区与 [0, train_end) 有任何交集就不是样本外。
    """
    return [a < train_end for a, _b in folds]
