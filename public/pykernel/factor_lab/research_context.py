"""ResearchContext —— 两入口通用的运行前研究契约(crypto_local_v2)

方案 §3:页面、CPU、GPU 各自维护不同默认值是口径漂移的根源。本模块把
profile、归一化策略、切分计划、执行模型解析成一份不可变对象,随搜索结果
冻结;复测/组合/继续进化复用同一份,不再各自重算。

版本纪律:
- crypto_ohlcv_v1(旧)与无 profile 的公式按旧语义逐位执行,本模块不改它们;
- crypto_local_v2 是新 profile 的显式版本号,未知版本/字段拒绝执行,
  不允许静默走旧执行器(方案 §3 关键规定);
- 旧 token 含义不动:新 profile 下只含旧 token 的公式同样获得 v2 的
  因果契约(归一化策略显式传入,与 token 是否"新"无关 —— 方案 2.1-C)。

纯函数;JSON 进出由 factor_local 组装。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .market import CRYPTO_PROFILE, is_crypto
from .scoring.split_plan import SplitPlan, build_split_plan

# 新 profile id(显式版本化;不覆盖旧 ID 含义)
PROFILE_CRYPTO_LOCAL_V2 = "crypto_local_v2"
CONTEXT_SCHEMA_VERSION = 1

# 执行模型(方案 §3):现货研究不输出可执行做空收益
EXECUTION_SIGNAL_RESEARCH = "signal_research"
EXECUTION_SPOT_LONG_FLAT = "spot_long_flat"
EXECUTION_PERP_NEXT_OPEN = "perp_next_open"
_EXECUTION_MODELS = (
    EXECUTION_SIGNAL_RESEARCH,
    EXECUTION_SPOT_LONG_FLAT,
    EXECUTION_PERP_NEXT_OPEN,
)

# 候选状态(独立于本地/服务端执行权限)
STATUS_EXPLORATORY = "exploratory"
STATUS_VALIDATION_PASSED = "validation_passed"
STATUS_HOLDOUT_PASSED = "holdout_passed"
STATUS_REJECTED = "rejected"
STATUS_PORTFOLIO_COMPONENT = "portfolio_component"

KNOWN_PROFILES = (CRYPTO_PROFILE, PROFILE_CRYPTO_LOCAL_V2)

# v2 归一化基础窗口:与旧 _BASE_ZSCORE_WINDOW 同为 200 bars 语义,
# 但推导方式前缀不变(见 norm_window_for_bars)。
_V2_BASE_WINDOW = 200


def norm_window_for_bars(bars: list[dict[str, Any]]) -> int:
    """前缀不变的归一化窗口推导(v2)。

    旧 zscore_window 用 len(bars)/distinct_trading_days(bars) 抬高 1m 窗口:
    分子含全段 bar 数,追加未来数据会改变过去输出的归一化基线(前缀不变性
    破坏,方案 2.1-C)。v2 改用头部 bar 间距推导日内 bar 密度 —— 间距由
    行情本身决定,与段长无关,追加数据不改变已有输出。

    crypto 7×24 连续交易:per_day = 86400s / bar 间距。间距无法解析时
    回落固定 200(与日线语义一致)。
    """
    from datetime import datetime

    if len(bars) < 3:
        return _V2_BASE_WINDOW
    gaps: list[float] = []
    for i in range(1, min(6, len(bars))):
        try:
            a = datetime.fromisoformat(str(bars[i - 1].get("time") or "")[:19])
            b = datetime.fromisoformat(str(bars[i].get("time") or "")[:19])
        except ValueError:
            continue
        sec = (b - a).total_seconds()
        if sec > 0:
            gaps.append(sec)
    if not gaps:
        return _V2_BASE_WINDOW
    gap = sorted(gaps)[len(gaps) // 2]  # 中位数抗单点异常
    per_day = 86400.0 / gap
    return max(_V2_BASE_WINDOW, int(per_day + 0.999999))


@dataclass(frozen=True)
class ResearchContext:
    """运行前解析后不可变的研究上下文(方案 §3 的首版落地)。"""

    schema_version: int
    profile_id: str
    execution_model: str
    timeframe: str
    norm_window: int
    label_span: int
    split: SplitPlan
    cost: float
    symbol: str
    market_type: str = "unknown"      # spot | perp;由渠道/合约元数据确定
    venue: str | None = None

    def to_summary(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "profile_id": self.profile_id,
            "execution_model": self.execution_model,
            "timeframe": self.timeframe,
            "norm_window": self.norm_window,
            "label_span": self.label_span,
            "cost": self.cost,
            "symbol": self.symbol,
            "market_type": self.market_type,
            "venue": self.venue,
            "split": self.split.to_summary(),
        }


def resolve_context(
    payload: dict[str, Any],
    bars: list[dict[str, Any]],
    cost: float,
) -> ResearchContext | None:
    """从 payload 解析 v2 研究上下文;非 v2 profile 返回 None(走旧路径)。

    未知 profile 版本显式报错,不静默回退旧执行器。
    """
    profile = str(payload.get("research_profile") or "")
    if not profile:
        return None
    if profile == PROFILE_CRYPTO_LOCAL_V2:
        if not is_crypto(bars):
            from .market import prepare_bars

            bars = prepare_bars({"crypto_profile": True, "symbol": payload.get("symbol")}, bars)
        execution = str(payload.get("execution_model") or EXECUTION_SIGNAL_RESEARCH)
        if execution not in _EXECUTION_MODELS:
            raise ValueError(f"未知执行模型: {execution}")
        timeframe = str(payload.get("timeframe") or "1d")
        label_span = int(payload.get("label_span") or 1)
        split = build_split_plan(
            len(bars),
            label_span=label_span,
            warmup=int(payload.get("warmup") or 250),
            bars=bars,
        )
        return ResearchContext(
            schema_version=CONTEXT_SCHEMA_VERSION,
            profile_id=PROFILE_CRYPTO_LOCAL_V2,
            execution_model=execution,
            timeframe=timeframe,
            norm_window=norm_window_for_bars(bars),
            label_span=label_span,
            split=split,
            cost=cost,
            symbol=str(payload.get("symbol") or ""),
            market_type=str(payload.get("market_type") or "unknown"),
            venue=payload.get("market_source"),
        )
    if profile in KNOWN_PROFILES:
        return None  # 旧 profile:旧路径,旧语义
    raise ValueError(
        f"未知 research_profile '{profile}':拒绝静默按旧版本执行;"
        f"已知版本: {', '.join(KNOWN_PROFILES)}"
    )


def classify_champion(metrics: dict[str, Any], plan_sufficient: bool) -> str:
    """候选状态映射(方案 §3):fallback/overfit_warning → exploratory/rejected。

    状态独立于本地/服务端执行权限;holdout_passed 仍是研究证据,
    不自动取得实盘权限。
    """
    if metrics.get("insufficient_samples"):
        return STATUS_EXPLORATORY
    if metrics.get("holdout_metrics") is not None and metrics.get("validation_passed"):
        return STATUS_HOLDOUT_PASSED
    if metrics.get("validation_passed"):
        return STATUS_VALIDATION_PASSED
    if metrics.get("overfit_warning"):
        return STATUS_REJECTED
    if not plan_sufficient:
        return STATUS_EXPLORATORY
    return STATUS_EXPLORATORY
