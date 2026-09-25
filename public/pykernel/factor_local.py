"""Pyodide 因子实验室入口:JSON 进、JSON 出。需先加载 numpy(loadPackage)。

模式(由 payload["mode"] 调度):
- "search"(默认):GP 因子搜索
- "backtest_factor":单因子资金曲线回测(对应服务端 /api/factor-lab/backtest-factor
  的纯计算部分,主体逐字移植;配额/鉴权/取数留服务端)

另有分代步进挖掘会话(mine_start/mine_step/mine_dispose,供本地长程挖掘任务
M3 使用):每次 mine_step 只推进一代就把控制权交回 JS,进度上报/暂停/取消都
落在代边界上,worker 不会被一次性几十分钟的 search() 阻塞死。
评估口径与 search()/search_stepwise 完全同源,不另写一套。
"""

from __future__ import annotations

import json
from dataclasses import fields as dc_fields

import numpy as np

from factor_lab import execute
from factor_lab.features import FEATURE_NAMES, feature_matrix, active_feature_ids
from factor_lab.market import prepare_bars
from factor_lab.scoring.cost import DEFAULT_SLIPPAGE_TICKS, turnover_cost_rate
from data.product_specs import normalize_crypto_symbol, CRYPTO_TICKS
from factor_lab.scoring.evaluate import (
    evaluate_factor,
    evaluate_factor_live,
    next_ret,
    position_from_factor,
)
from factor_lab.scoring.periods import bars_per_year
from factor_lab.scoring.walk_forward import MIN_TEST_BARS, split_bars
from factor_lab.search import (
    SearchConfig,
    _dedup_top,
    search,
    search_stepwise,
)
from factor_lab.token_encoding import FEAT_OFFSET as _FEAT_OFFSET
from factor_lab.vm import execute_for_bars, is_constant, validate

# 允许透传的 SearchConfig 字段(其余保持内核默认;LLM coach/配额/落库属服务端)
_CFG_FIELDS = {f.name for f in dc_fields(SearchConfig)}

# 标准特征空间大小(与服务端 FEATURE_NAMES 对齐的部分;id 36-39 为桌面端
# 本地专属批次)。含 id ≥ 该值 token 的公式服务端无法执行 → 打 local_only 标,
# 前端拦截收藏/服务端任务挂载;本地引擎 AI 任务(客户端算信号)可用。
# 服务端将来扩容其特征时需同步抬高该值。
STANDARD_FEAT_COUNT = 36


def _mark_local_only(metrics: dict, tokens: list) -> dict:
    """纯函数:返回带 local_only 标记的 metrics 副本(不改入参)

    判定只看特征 token 区间 [STANDARD_FEAT_COUNT, FEAT_OFFSET)——算子
    token 从 FEAT_OFFSET=64 起,不经排除会把所有含算子的公式误判为本地专属。
    """
    out = dict(metrics)
    out["local_only"] = any(
        STANDARD_FEAT_COUNT <= int(t) < _FEAT_OFFSET or int(t) >= _FEAT_OFFSET + 40 for t in tokens
    )
    return out


def run(payload_json: str, bars_json: str) -> str:
    payload = json.loads(payload_json)
    mode = str(payload.get("mode") or "search")
    bars = json.loads(bars_json)
    # 未知研究 profile 显式拒绝,不允许静默走旧执行器(方案 §3)
    _reject_unknown_profile(payload)
    if mode == "backtest_factor":
        return run_backtest_factor(payload, bars)
    if mode == "mine_features":
        return run_mine_features(payload, bars)
    if mode == "mine_gpu_dispose":
        _GPU_INPUTS.pop(str(payload.get("gpu_session_id") or ""), None)
        return json.dumps({"disposed": True})
    if mode == "mine_precise":
        return run_mine_precise(payload, bars)
    if mode == "mine_eval_shard":
        return run_mine_shard(payload, bars)
    if mode == "mine_portfolio":
        return run_mine_portfolio(payload, bars)
    if mode == "llm_vocab":
        return run_llm_vocab(payload, bars)
    if mode == "cross_peer_symbols":
        return run_cross_peer_symbols(payload, bars)
    if mode == "research_context":
        return run_research_context(payload, bars)
    if mode == "version":
        return json.dumps({"kernel_version": kernel_version()}, ensure_ascii=False)
    return run_search(payload, bars)


def _reject_unknown_profile(payload: dict) -> None:
    from factor_lab.research_context import KNOWN_PROFILES

    profile = str(payload.get("research_profile") or "")
    if profile and profile not in KNOWN_PROFILES:
        raise ValueError(
            f"未知 research_profile '{profile}':拒绝静默按旧版本执行;"
            f"已知版本: {', '.join(KNOWN_PROFILES)}"
        )


def run_research_context(payload: dict, bars: list) -> str:
    """运行前研究上下文预检:切分计划、样本充分性、归一化窗口、数据能力。

    两入口在搜索发起前调用本入口展示:启用特征、每段长度、验证折数、
    样本缺口(方案 5.3「运行前显示」与任务 10 界面数据源)。非 v2 profile
    返回 legacy 标记。
    """
    from factor_lab.research_context import resolve_context

    bars = prepare_bars(payload, bars)
    cost = resolve_search_cost(payload, bars)
    ctx = resolve_context(payload, bars, cost)
    if ctx is None:
        profile = str(payload.get("research_profile") or "") or "legacy"
        return json.dumps(
            {
                "profile_id": profile,
                "legacy": True,
                "bars": len(bars),
                "cost": cost,
            },
            ensure_ascii=False,
        )
    from factor_lab.features import active_feature_ids, feature_matrix

    mat = feature_matrix(bars[: ctx.split.train_end] if ctx.split.sufficient else bars)
    try:
        active = active_feature_ids(mat, True, max_head_gap=250)
    except ValueError:
        active = []
    return json.dumps(
        {
            **ctx.to_summary(),
            "legacy": False,
            "active_feature_ids": active,
            "kernel_version": kernel_version(),
        },
        ensure_ascii=False,
        default=str,
    )


def _reveal_v2_holdout(champions: list[dict], payload: dict, bars: list, cost: float) -> None:
    """crypto_local_v2 封存段一次性揭示:仅在最终代调用(方案 §5)。

    搜索全程只见 [0, validation_end);本函数在 [validation_end, n) 上对
    最终冠军做唯一一次评估,写入 holdout_metrics + holdout_passed。
    样本不足(无封存段)时不揭示。修改封存数据不会改变训练候选或验证
    名单——它们在搜索时已冻结。
    """
    from factor_lab.research_context import resolve_context
    from factor_lab.scoring.evaluate import next_ret, position_from_factor, _sortino
    from factor_lab.scoring.periods import bars_per_year
    from factor_lab.vm import execute_for_bars

    ctx = resolve_context(payload, bars, cost)
    if ctx is None or not ctx.split.sufficient:
        return
    plan = ctx.split
    lo, hi = plan.validation_end, plan.holdout_end - plan.tail_unclear_bars
    n_score = hi - lo
    if n_score <= 0:
        return
    context_start = max(0, lo - plan.warmup)
    ctx_bars = bars[context_start:hi]
    mat = feature_matrix(ctx_bars)
    timeframe = ctx.timeframe
    periods = bars_per_year(ctx_bars[-n_score:], timeframe)
    close = np.array([float(b.get("close") or 0) for b in ctx_bars[-n_score:]], dtype=float)
    ret = next_ret(close)
    for c in champions:
        tokens = [int(t) for t in c.get("tokens") or []]
        if not tokens or not c.get("metrics", {}).get("validation_passed"):
            continue  # 只有通过验证的冻结候选才揭示封存
        factor = execute_for_bars(tokens, mat, ctx_bars)
        if factor is None:
            continue
        factor = factor[-n_score:]
        pos = position_from_factor(factor)
        prev = np.roll(pos, 1)
        prev[0] = 0.0
        turnover = np.abs(pos - prev)
        pnl = pos * ret - turnover * cost
        pnl_2x = pos * ret - turnover * cost * 2.0
        m = c["metrics"]
        m["holdout_metrics"] = {
            "ann_ret": float(pnl.mean() * periods),
            "sortino": float(_sortino(pnl, periods)),
            "sortino_2x": float(_sortino(pnl_2x, periods)),
            "avg_turnover": float(turnover.mean()),
            "bars": float(n_score),
        }
        # 封存按预注册标准评估:1×/2×成本净 sortino 均 >0 才算通过;
        # 不根据封存指标重新排序或补选候选
        m["holdout_passed"] = bool(m["holdout_metrics"]["sortino"] > 0 and m["holdout_metrics"]["sortino_2x"] > 0)
        m["candidate_status"] = "holdout_passed" if m["holdout_passed"] else "rejected"


def run_search(payload: dict, bars: list) -> str:
    bars = prepare_bars(payload, bars)
    cfg_kwargs = {k: payload[k] for k in _CFG_FIELDS if k in payload}
    # cost 省略与 cost=None 同路径(自动推导,对齐服务端 search_api 语义):
    # 原样透传 None 会让 evaluate_factor 对全体候选抛异常,被 eval 防护静默
    # 吞掉后 best_seen 为空,最终 0 冠军且无任何报错
    if cfg_kwargs.get("cost") is None:
        cfg_kwargs["cost"] = resolve_search_cost(payload, bars)
    cfg = SearchConfig(**cfg_kwargs)
    if cfg.research_profile == "crypto_local_v2":
        cfg.crypto_profile = True  # v2 隐含加密口径(特征空间/成本解析)
    if cfg.crypto_profile and cfg.cross_peers:
        cfg.cross_peers = [(symbol, prepare_bars({**payload, "symbol": symbol}, peer))
                           for symbol, peer in cfg.cross_peers]
    full_bars = list(bars)
    champions = search(bars, str(payload.get("timeframe") or "1d"), cfg)
    out = [
        {
            "tokens": c.tokens,
            "text": c.text,
            "metrics": _mark_local_only(c.metrics, c.tokens),
            "composite": c.composite,
        }
        for c in champions
    ]
    if cfg.research_profile == "crypto_local_v2" and payload.get("final_generation", True):
        # 封存段一次性揭示:仅最终代、仅通过验证的冻结候选
        _reveal_v2_holdout(out, payload, full_bars, cfg.cost)
    if cfg.research_profile == "crypto_local_v2":
        from factor_lab.research_context import resolve_context

        ctx = resolve_context(payload, full_bars, cfg.cost)
        if ctx is not None:
            for item in out:
                item["metrics"]["research_context"] = ctx.to_summary()
    return json.dumps(out, ensure_ascii=False, default=str)


# ── 单因子回测(服务端 backtest_api.py 主体逐字移植)─────────────────────


def resolve_cost(symbol: str, bars: list, cost: float | None) -> float:
    """解析单位 turnover 成本率(服务端 api/factor_lab/common.py 同名函数移植)。

    加密符号先归一(各所原生写法统一),未知加密币种(不在 CRYPTO_TICKS)
    显式报错——静默回落期货默认规格会把 multiplier/tick 全算错。
    """
    if cost is not None:
        return cost
    norm = normalize_crypto_symbol(symbol)
    if norm and norm[: -len("usdt")].upper() not in CRYPTO_TICKS:
        raise ValueError(
            f"未知加密币种 {symbol}:缺少交易规格(tick/费率),请在表单显式填写成本率"
        )
    valid = [float(b.get("close") or 0) for b in bars]
    valid = [c for c in valid if c > 0]
    if not valid:
        return 0.0
    recent = valid[-max(60, len(valid) // 4):]
    price = sorted(recent)[len(recent) // 2]
    return turnover_cost_rate(norm or symbol, price, DEFAULT_SLIPPAGE_TICKS)


def resolve_search_cost(payload: dict, bars: list) -> float:
    """Freeze crypto search cost from the training segment, never held-out prices."""
    cost = payload.get("cost")
    if payload.get("crypto_profile") and cost is None:
        cfg = SearchConfig(**{k: payload[k] for k in _CFG_FIELDS if k in payload and k != "cost"})
        bars, _ = _split_train_test(cfg, bars)
    return resolve_cost(str(payload.get("symbol") or ""), bars, None if cost is None else float(cost))


def _round_value(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, dict):
        return {kk: _round_value(vv) for kk, vv in v.items()}
    if isinstance(v, list):
        return [_round_value(x) for x in v]
    if isinstance(v, (int, float)):
        return round(float(v), 4)
    return v


def _round_metrics(metrics: dict) -> dict:
    return {k: _round_value(v) for k, v in metrics.items()}


def run_backtest_factor(payload: dict, bars: list) -> str:
    bars = prepare_bars(payload, bars)
    symbol = str(payload.get("symbol") or "")
    timeframe = str(payload.get("timeframe") or "1d")
    tokens = payload.get("factor_tokens") or []
    initial_cash = float(payload.get("initial_cash") or 100000.0)
    cost_input = payload.get("cost")
    wf_folds = int(payload.get("walk_forward_folds") or 0)
    norm_window = int(payload.get("norm_window") or 250)  # P0-2 因果归一化窗

    mat = feature_matrix(bars)
    from factor_lab.market import is_v2

    if is_v2(bars):
        # v2:归一化窗口由研究契约持有(前缀不变推导),不取 legacy 默认 250
        factor = execute_for_bars(tokens, mat, bars)
    else:
        factor = execute(tokens, mat, norm_window)
    if factor is None:
        return json.dumps({"error": "因子公式无效或无法执行"}, ensure_ascii=False)
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    cost = resolve_cost(symbol, bars, None if cost_input is None else float(cost_input))
    periods = bars_per_year(bars, timeframe)
    metrics = evaluate_factor(factor, close, cost=cost, periods=periods)
    # 实盘离散口径(±1 手、0.3 入场/0.05 平仓)
    live_metrics = evaluate_factor_live(factor, close, cost=cost, periods=periods)
    pos = position_from_factor(factor)
    ret = next_ret(close)
    # P1-6:与 evaluate_factor 完全同式——prev[0]=0(首根保留建仓成本,不用
    # 环绕的 pos[-1]);资金曲线右移一根,第 t 根显示的是 t-1 决策已实现的
    # 盈亏(原实现把 i→i+1 的收益标在 i 上,图形上"信号一出当根就赚钱")
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    pnl = pos * ret - np.abs(pos - prev) * cost
    realized = np.roll(pnl, 1)
    realized[0] = 0.0
    equity = initial_cash * (1.0 + np.cumsum(realized))

    wf_detail = None
    if wf_folds > 0:
        from factor_lab.scoring.walk_forward import walk_forward_eval

        wf_detail = walk_forward_eval(tokens, bars, timeframe, cost, wf_folds)

    n = len(bars)
    step = max(1, n // 300)
    curve = [
        {
            "time": str(bars[i].get("time") or ""),
            "equity": round(float(equity[i]), 2),
            "position": round(float(pos[i]), 4),
            "price": round(float(close[i]), 4),
        }
        for i in range(0, n, step)
    ]
    if (n - 1) % step:
        curve.append(
            {
                "time": str(bars[-1].get("time") or ""),
                "equity": round(float(equity[-1]), 2),
                "position": round(float(pos[-1]), 4),
                "price": round(float(close[-1]), 4),
            }
        )

    result = {
        "symbol": symbol,
        "timeframe": timeframe,
        "bars": n,
        "range": {
            "from": bars[0].get("time") if bars else None,
            "to": bars[-1].get("time") if bars else None,
        },
        "cost": cost,
        "cost_auto": cost_input is None,
        "metrics": _round_metrics(metrics),
        "live_metrics": _round_metrics(live_metrics),
        "equity_curve": curve,
    }
    if wf_detail is not None:
        result["walk_forward"] = {
            "folds": wf_detail["folds"],
            "wf_stable": wf_detail["wf_stable"],
            "wf_mean_test_sortino": round(wf_detail["wf_mean_test_sortino"], 4),
            "wf_mean_test_ann": round(wf_detail["wf_mean_test_ann"], 4),
            "wf_consistency": round(wf_detail["wf_consistency"], 4),
            "n_folds": wf_detail["n_folds"],
        }
    return json.dumps(result, ensure_ascii=False, default=str)


# ── 冠军组合评估(深挖强化 M4)─────────────────────────────────


def run_mine_portfolio(payload: dict, bars: list) -> str:
    """冠军组合评估(等权/IC 加权 vs 最优单因子,scoring/portfolio.py 现成实现)

    payload 未带切分参数时在全段 bars 上评估(旧口径)。带 train_ratio/
    test_recent_bars 时只在样本外段评估(IC 权重只用训练段估计):冠军是在
    训练段上挑出来的,全段组合指标含训练段 = 样本内虚高。selection_v2 时
    进一步只用封存段(验证段已参与冠军遴选)。<2 个可执行因子时 portfolio=None。
    """
    bars = prepare_bars(payload, bars)
    from factor_lab.scoring.portfolio import evaluate_portfolio
    from factor_lab.search import holdout_len

    symbol = str(payload.get("symbol") or "")
    timeframe = str(payload.get("timeframe") or "1d")
    tokens_list: list[list[int]] = []
    for raw in payload.get("tokens_list") or []:
        tokens = [int(t) for t in raw if isinstance(t, (int, float))]
        if tokens:
            tokens_list.append(tokens)
    if len(tokens_list) < 2:
        return json.dumps({"portfolio": None}, ensure_ascii=False)
    cost_input = payload.get("cost")
    cost = resolve_search_cost(payload, bars)
    eval_from: int | None = None
    segment = "full"
    if payload.get("train_ratio") or payload.get("test_recent_bars"):
        split_cfg = SearchConfig(
            train_ratio=float(payload.get("train_ratio") or 0.0),
            test_recent_bars=int(payload.get("test_recent_bars") or 0),
        )
        _train, test = _split_train_test(split_cfg, bars)
        if len(test) >= MIN_TEST_BARS:
            eval_from, segment = len(bars) - len(test), "test"
            n_hold = holdout_len(len(test)) if payload.get("selection_v2") else 0
            if n_hold:
                eval_from, segment = len(bars) - n_hold, "holdout"
    result = evaluate_portfolio(bars, timeframe, tokens_list, cost, eval_from=eval_from)
    if result is not None and eval_from is not None:
        result["segment"] = segment
        result["eval_bars"] = len(bars) - eval_from
    return json.dumps(
        {"portfolio": _round_value(result)}, ensure_ascii=False, default=str
    )


# ── LLM 种子词表(路线 B 本地化,深挖强化 M5)─────────────────────


def run_llm_vocab(payload: dict, bars: list) -> str:
    """特征/算子词表 + token 编码规则 —— LLM 生成因子候选的输入约定

    从 FEATURE_NAMES/OPS_CONFIG/文案表直接产出(单一事实源,不另维护一份
    JS 词表);生成的 token 仍走 StackVM 校验,非法候选会被丢弃。

    crypto 词表按**实际数据能力**生成(2026-09-25 fix F):传入 bars 时用
    训练段特征矩阵的可用性(active_feature_ids)决定开放哪些特征——
    funding/OI/直连微结构字段真实覆盖时开放,不可用时排除并在
    excluded_features 给出原因;不再一律禁止 52-58,也不一律开放。
    无 bars 时保守排除直连特征(可用性未知)。
    """
    from factor_lab.express import _FEAT_TEXT, _OP_TEXT
    from factor_lab.features import FEATURE_NAMES
    from factor_lab.ops import OPS_CONFIG
    from factor_lab.token_encoding import FEAT_OFFSET

    feats = [
        {"id": i, "name": n, "text": _FEAT_TEXT.get(n, n)}
        for i, n in enumerate(FEATURE_NAMES)
    ]
    excluded_reasons: dict[str, str] = {}
    if payload.get("crypto_profile"):
        from factor_lab.market import is_v2, prepare_bars

        if bars:
            # 只用训练段评估可用性(v2 显式切分),不向 LLM 暴露封存段细节
            bars = prepare_bars(payload, bars)
            cfg_kwargs = {
                k: payload[k]
                for k in _CFG_FIELDS
                if k in payload and k not in ("cost", "cross_peers")
            }
            cfg = SearchConfig(**cfg_kwargs)
            train_bars, _ = _split_train_test(cfg, bars)
            from factor_lab.features import active_feature_ids, feature_matrix

            mat = feature_matrix(train_bars)
            try:
                active = set(
                    active_feature_ids(mat, True, max_head_gap=250 if is_v2(bars) else None)
                )
            except ValueError:
                active = set()
            excluded_reasons = {
                FEATURE_NAMES[i]: "训练段数据不可用(缺失/常数/覆盖不足)"
                for i in range(len(FEATURE_NAMES))
                if i not in active
            }
            feats = [f for f in feats if f["id"] in active]
        else:
            # 无行情快照:直连特征可用性未知,保守排除(不臆造数据能力)
            static_excluded = set(range(52, len(FEATURE_NAMES)))
            excluded_reasons = {
                FEATURE_NAMES[i]: "数据可用性未知(未传行情快照)" for i in static_excluded
            }
            feats = [f for f in feats if f["id"] not in static_excluded]
    ops = [
        {
            "id": FEAT_OFFSET + i,
            "name": str(entry[0]),
            "text": _OP_TEXT.get(str(entry[0]), str(entry[0])),
            "arity": int(entry[2]),
        }
        for i, entry in enumerate(OPS_CONFIG)
    ]
    return json.dumps(
        {
            "feat_offset": FEAT_OFFSET,
            "features": feats,
            "ops": ops,
            "excluded_features": excluded_reasons,
        },
        ensure_ascii=False,
    )


# ── 跨品种验证伙伴解析(深挖强化)───────────────────────────────


def run_cross_peer_symbols(payload: dict, bars: list) -> str:
    """品种 → 同板块验证伙伴品种代码(按板块内流动性排序取前 count 个)

    板块映射单一事实源(product_sectors);调用方拿代码自行拉 K 线组装
    cross_peers 注入 SearchConfig(严格筛 ≥⌈K/2⌉ 伙伴 sortino>0)。
    """
    from product_sectors import get_cross_peers, get_sector
    from data.contracts import get_code_for_symbol

    symbol = str(payload.get("symbol") or "")
    raw_count = payload.get("count")
    count = int(raw_count) if raw_count is not None else 4
    count = max(1, min(4, count))
    code = get_code_for_symbol(symbol) or (
        "".join(ch for ch in symbol.lower() if ch.isalpha())
    )
    return json.dumps(
        {
            "code": code,
            "sector": get_sector(code),
            "peers": get_cross_peers(code, count),
        },
        ensure_ascii=False,
    )


def kernel_version() -> str:
    # 2026-09-25.2: crypto profile, new features/operators, training cost, sealed reporting.
    # 加密币口径(2026-09-25.1):加密 specs(multiplier=1/taker 万5/按币 tick)、
    # 符号别名归一(各所原生写法)、未知加密币显式报错、cost 省略与 null
    # 同路径自动推导(run_search/mine_start/shard/precise 四处)。
    # 2026-09-25.4: crypto_local_v2 研究契约(60/20/20 显式切分/前缀不变
    # 归一化/缺失掩码/样本充分性门/封存一次性揭示)+ funding 事件现金流
    # + perp_next_open 执行口径 + robust_zscore/winsor 算子(append-only,
    # id 44/45)+ 因子族种子模板 + 有界多样性档案。legacy(crypto_ohlcv_v1
    # 与空 profile)路径行为不变;v2 结果按本戳区分。
    # 更早:批次三口径变更(P0-2 因果归一化;P1-7 warmup 切片与
    # MIN_TEST_BARS=120);同因子在新旧内核下指标不同,历史/收藏按此戳区分
    return "pykernel-factor-2026-09-25.4"


# ── 分代步进挖掘会话(本地长程任务 M3) ─────────────────────────


_SESSIONS: dict[str, dict] = {}


def _decode_seed_best(raw) -> list[tuple[float, list[int], dict]] | None:
    """JS 持久化的历史最优摘要 → search_stepwise 的 seed_best 格式。

    续训语义(决策记录 D-1):start_generation 只跳过已完成代数,种群重新随机
    初始化,seed_best 注入历史最优作种子进入新种群——不是精确恢复演化轨迹。
    """
    if not raw:
        return None
    out: list[tuple[float, list[int], dict]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            comp = float(item.get("composite"))
            tokens = [int(t) for t in (item.get("tokens") or [])]
        except (TypeError, ValueError):
            continue
        metrics = item.get("metrics") or {}
        if tokens:
            out.append((comp, tokens, metrics))
    return out or None


def mine_start(payload_json: str, bars_json: str) -> str:
    """创建分代步进会话( bars 由会话持有,后续 mine_step 不再重传),返回 session_id"""
    payload = json.loads(payload_json)
    bars = prepare_bars(payload, json.loads(bars_json))
    cfg_kwargs = {k: payload[k] for k in _CFG_FIELDS if k in payload}
    # cost 省略与 cost=null 同规则解析(与 run_search 一致),防止 None 透传
    # 导致全体候选评估异常被静默吞掉、0 冠军无报错
    if cfg_kwargs.get("cost") is None:
        cfg_kwargs["cost"] = resolve_search_cost(payload, bars)
    cfg = SearchConfig(**cfg_kwargs)
    if cfg.crypto_profile and cfg.cross_peers:
        cfg.cross_peers = [(symbol, prepare_bars({**payload, "symbol": symbol}, peer))
                           for symbol, peer in cfg.cross_peers]
    seed_best = _decode_seed_best(payload.get("seed_best"))
    gen = search_stepwise(
        bars,
        str(payload.get("timeframe") or "1d"),
        cfg,
        start_generation=int(payload.get("start_generation") or 0),
        seed_best=seed_best,
    )
    sid = str(payload.get("session_id") or "s1")
    _SESSIONS[sid] = {"gen": gen}
    return json.dumps({"session_id": sid}, ensure_ascii=False)


def mine_step(session_id: str) -> str:
    """推进一代;返回该代快照,迭代完毕返回 {"done": true}"""
    s = _SESSIONS.get(session_id)
    if s is None:
        return json.dumps({"error": "会话不存在"}, ensure_ascii=False)
    try:
        snap = next(s["gen"])
    except StopIteration:
        _SESSIONS.pop(session_id, None)
        return json.dumps({"done": True}, ensure_ascii=False)
    return json.dumps(
        {
            "done": False,
            "generation": snap.generation,
            "total_generations": snap.total_generations,
            "best_composite": snap.best_composite,
            **({"stats": snap.stats} if snap.stats else {}),
            "champions": [
                {
                    "tokens": c.tokens,
                    "text": c.text,
                    "metrics": _mark_local_only(_round_metrics(c.metrics), c.tokens),
                    "composite": c.composite,
                }
                for c in snap.champions
            ],
        },
        ensure_ascii=False,
        default=str,
    )


def mine_dispose(session_id: str) -> str:
    _SESSIONS.pop(session_id, None)
    return "{}"


# ── GPU 粗排配套入口(M4) ─────────────────────────────────────
#
# 分工(文档 2.8):树的生成/交叉/变异在 JS,因子求值+适应度粗排在 WGSL(f32),
# 每代 top-K 的精确指标与最继行情一律回到本内核(f64)。由此两个入口:
# - mine_features:导出训练段特征矩阵/年化基数/成本率 —— 特征必须由内核产出,
#   GPU 不重算特征,否则出现第三套口径;
# - mine_precise:给定候选 tokens 做 f64 精算,并入 best_seen 后走 _dedup_top
#   (严格筛/walk-forward/兜底回退全部复用既有 Python 实现)。GPU 的任何
#   数字不落 UI/DB/实盘路径。


def _split_train_test(cfg: SearchConfig, bars: list) -> tuple[list, list]:
    """防过拟合切分 —— 与 search()/search_stepwise() 逐字同源(单点维护)

    v2:60/20/20 显式计划;返回的 test 是验证区(封存区由调用方另行处理,
    本函数不返回封存段——避免任何路径意外把它当验证用)。
    """
    if cfg.research_profile == "crypto_local_v2":
        from factor_lab.scoring.split_plan import build_split_plan

        plan = build_split_plan(len(bars), label_span=cfg.label_span, warmup=250, bars=bars)
        if plan.sufficient:
            return list(bars[: plan.train_end]), list(bars[plan.train_end : plan.validation_end])
        return list(bars), []
    if cfg.test_recent_bars > 0:
        cut = max(MIN_TEST_BARS, len(bars) - cfg.test_recent_bars)
        if cut < MIN_TEST_BARS or (len(bars) - cut) < MIN_TEST_BARS:
            return list(bars), []
        return list(bars[:cut]), list(bars[cut:])
    if cfg.train_ratio > 0.0:
        return split_bars(bars, cfg.train_ratio)
    return list(bars), []


_GPU_INPUTS: dict = {}


def _gpu_input_key(payload: dict, cfg: SearchConfig) -> tuple:
    return (str(payload.get("timeframe") or "1d"), cfg.train_ratio, cfg.test_recent_bars, cfg.crypto_profile, cfg.research_profile, cfg.label_span, cfg.execution_model)


def run_mine_features(payload: dict, bars: list) -> str:
    """训练段特征矩阵 + periods + 已解析成本率(GPU 粗排的只读输入)"""
    bars = prepare_bars(payload, bars)
    timeframe = str(payload.get("timeframe") or "1d")
    cfg_kwargs = {
        k: payload[k] for k in _CFG_FIELDS if k in payload and k != "cost"
    }
    cfg = SearchConfig(**cfg_kwargs)
    if cfg.crypto_profile and cfg.cross_peers:
        cfg.cross_peers = [(symbol, prepare_bars({**payload, "symbol": symbol}, peer))
                           for symbol, peer in cfg.cross_peers]
    train_bars, test_bars = _split_train_test(cfg, bars)
    mat = feature_matrix(train_bars)
    periods = bars_per_year(train_bars, timeframe)
    cost_input = payload.get("cost")
    cost = resolve_search_cost(payload, bars)
    session_id = str(payload.get("gpu_session_id") or "")
    if session_id:
        if session_id in _GPU_INPUTS:
            raise ValueError("GPU input session already exists")
        if len(_GPU_INPUTS) >= 8:
            raise ValueError("Too many active GPU input sessions")
        # Inputs are task-frozen; only preparation is cached, never f64 results.
        _GPU_INPUTS[session_id] = {
            "key": _gpu_input_key(payload, cfg),
            "bars": bars, "train": train_bars, "test": test_bars, "matrix": mat,
            "close": np.array([float(b.get("close") or 0) for b in train_bars], dtype=float),
            "periods": periods,
        }
    return json.dumps(
        {
            "active_feature_ids": active_feature_ids(mat, cfg.crypto_profile),
            "feature_names": list(FEATURE_NAMES),
            "matrix": np.nan_to_num(mat, nan=0.0, posinf=0.0, neginf=0.0).tolist(),
            "periods": int(periods),
            "cost": float(cost),
            "train_len": len(train_bars),
            "total_len": len(bars),
        },
        ensure_ascii=False,
    )


# ── 精算分片(多 Pyodide worker 并行,深挖强化)──────────────────
#
# 每代 top-K 候选的评估(execute + evaluate_factor)是纯计算、无状态,
# 分片到 N 个 worker 并行;有状态的 _dedup_top(WF/测试段/跨品种/兜底)
# 仍单点在主实例出权威数字。bars 冻结(任务快照),分片 worker 首次调用
# 缓存 bars 与任务级参数,后续每代只传候选分片。

_SHARD: dict = {}


def run_mine_shard(payload: dict, bars: list) -> str:
    """分片评估:输入候选 tokens,输出 [{composite, tokens, metrics}]。

    bars 非空时更新缓存(任务级参数一并缓存);为空时用缓存——调用方
    首次带 bars 初始化,后续每代只传 candidates(载荷几十 KB)。
    评估循环与 run_mine_precise 的候选段逐字同源(单点维护)。
    """
    bars = prepare_bars(payload, bars)
    if bars:
        _SHARD["bars"] = bars
        _SHARD["payload"] = payload
    base = _SHARD.get("payload") or payload
    shard_bars = _SHARD.get("bars") or []
    timeframe = str(base.get("timeframe") or "1d")
    cfg_kwargs = {k: base[k] for k in _CFG_FIELDS if k in base}
    if cfg_kwargs.get("cost") is None:
        cfg_kwargs["cost"] = resolve_search_cost(base, shard_bars)
    cfg = SearchConfig(**cfg_kwargs)
    if cfg.crypto_profile and cfg.cross_peers:
        cfg.cross_peers = [(symbol, prepare_bars({**payload, "symbol": symbol}, peer))
                           for symbol, peer in cfg.cross_peers]
    train_bars, _test = _split_train_test(cfg, shard_bars)
    feat_mat = feature_matrix(train_bars)
    close = np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)
    periods = bars_per_year(train_bars, timeframe)
    v2 = cfg.research_profile == "crypto_local_v2"
    head_trim = 0
    if v2:
        from factor_lab.search import _v2_head_trim
        from factor_lab.features import active_feature_ids

        try:
            head_trim = _v2_head_trim(
                feat_mat, active_feature_ids(feat_mat, True, max_head_gap=250)
            )
        except ValueError:
            head_trim = 0

    out = []
    for raw in payload.get("candidates") or []:
        tokens = [int(t) for t in raw if isinstance(t, (int, float))]
        if not tokens:
            continue
        if validate(tokens):
            continue
        try:
            factor = (
                execute_for_bars(tokens, feat_mat, train_bars)
                if v2
                else execute(tokens, feat_mat)
            )
            if factor is None or is_constant(factor[head_trim:] if head_trim else factor):
                continue
            if head_trim:
                metrics = evaluate_factor(factor[head_trim:], close[head_trim:], cost=cfg.cost, periods=periods)
            else:
                metrics = evaluate_factor(factor, close, cost=cfg.cost, periods=periods)
        except Exception:
            continue
        comp = float(metrics["composite"]) - 0.02 * max(0, len(tokens) - 12)
        out.append({"composite": comp, "tokens": tokens, "metrics": metrics})
    return json.dumps({"evaluated": out}, ensure_ascii=False, default=str)


def run_mine_precise(payload: dict, bars: list) -> str:
    """GPU 粗排后的 f64 精算 + 权威排行(search() 同口径,粗排分数不进任何结果)"""
    bars = prepare_bars(payload, bars)
    session_id = str(payload.get("gpu_session_id") or "")
    prepared = None
    if session_id:
        prepared = _GPU_INPUTS.get(session_id)
        if prepared is None:
            raise ValueError("GPU input session missing; restart mining task")
        if bars:
            raise ValueError("GPU input session cannot replace frozen bars")
        bars = prepared["bars"]
    timeframe = str(payload.get("timeframe") or "1d")
    cfg_kwargs = {k: payload[k] for k in _CFG_FIELDS if k in payload}
    if cfg_kwargs.get("cost") is None:
        cfg_kwargs["cost"] = resolve_search_cost(payload, bars)
    cfg = SearchConfig(**cfg_kwargs)
    if cfg.research_profile == "crypto_local_v2":
        cfg.crypto_profile = True
    if cfg.crypto_profile and cfg.cross_peers:
        cfg.cross_peers = [(symbol, prepare_bars({**payload, "symbol": symbol}, peer))
                           for symbol, peer in cfg.cross_peers]
    # v2:显式切分计划;封存段对精算去重不可见(与 search() 一致)
    v2 = cfg.research_profile == "crypto_local_v2"
    full_bars = list(bars)
    plan = None
    head_trim = 0
    if v2:
        from factor_lab.search import _v2_head_trim
        from factor_lab.scoring.split_plan import build_split_plan

        plan = build_split_plan(
            len(bars), label_span=cfg.label_span, warmup=250, bars=bars
        )
        if plan.sufficient:
            bars = list(bars[: plan.validation_end])
        train_bars = list(bars[: plan.train_end]) if plan.sufficient else list(bars)
        test_bars = list(bars[plan.train_end :]) if plan.sufficient else []
    if prepared is not None:
        if prepared["key"] != _gpu_input_key(payload, cfg):
            raise ValueError("GPU input session configuration mismatch")
        if v2:
            prepared["train"] = train_bars
            prepared["test"] = test_bars
        train_bars, test_bars = prepared["train"], prepared["test"]
        feat_mat, close, periods = prepared["matrix"], prepared["close"], prepared["periods"]
    elif not v2:
        train_bars, test_bars = _split_train_test(cfg, bars)
        feat_mat = feature_matrix(train_bars)
        close = np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)
        periods = bars_per_year(train_bars, timeframe)
    else:
        feat_mat = feature_matrix(train_bars)
        close = np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)
        periods = bars_per_year(train_bars, timeframe)
    if v2:
        from factor_lab.features import active_feature_ids

        head_trim = _v2_head_trim(
            feat_mat, active_feature_ids(feat_mat, True, max_head_gap=250)
        )
    use_test = bool(test_bars) and len(test_bars) >= MIN_TEST_BARS
    if v2:
        use_test = plan is not None and plan.sufficient

    best_seen: list[tuple[float, list[int], dict]] = list(
        _decode_seed_best(payload.get("best_seen")) or []
    )
    for raw in payload.get("candidates") or []:
        tokens = [int(t) for t in raw if isinstance(t, (int, float))]
        if not tokens:
            continue
        if validate(tokens):
            continue
        try:
            factor = (
                execute_for_bars(tokens, feat_mat, train_bars)
                if v2
                else execute(tokens, feat_mat)
            )
            if factor is None or is_constant(factor[head_trim:] if head_trim else factor):
                continue
            if head_trim:
                metrics = evaluate_factor(factor[head_trim:], close[head_trim:], cost=cfg.cost, periods=periods)
            else:
                metrics = evaluate_factor(factor, close, cost=cfg.cost, periods=periods)
        except Exception:
            continue
        comp = float(metrics["composite"]) - 0.02 * max(0, len(tokens) - 12)
        best_seen.append((comp, tokens, metrics))

    # 分片 worker 已评估的候选直接并入(评估在 shard 池完成,此处零重复计算)
    for raw in payload.get("evaluated") or []:
        if not isinstance(raw, dict):
            continue
        # 护栏:只接受带完整 f64 指标的条目(分片 worker 的 evaluate_factor 产出)。
        # 缺 sortino 说明不是内核 f64 结果 —— 丢弃,不允许进 best_seen/champions
        # (GPU 的任何数字只许用于排序,绝不出数)。
        if "sortino" not in (raw.get("metrics") or {}):
            continue
        tokens = [
            int(t) for t in raw.get("tokens") or [] if isinstance(t, (int, float))
        ]
        if not tokens:
            continue
        best_seen.append(
            (float(raw.get("composite") or 0.0), tokens, raw.get("metrics") or {})
        )

    trials = int(payload.get("trials") or 0)
    champions = _dedup_top(
        list(best_seen),
        cfg.top_n,
        test_bars=test_bars,
        timeframe=timeframe,
        cost=cfg.cost,
        use_test=use_test,
        walk_forward_folds=cfg.walk_forward_folds,
        all_bars=bars,
        train_bars=train_bars,
        trials=trials,
        live_fill_gate=cfg.live_fill_gate,
        # 跨品种验证:伙伴 bars 由 JS 预加载注入(无数据时内核返回通过,不误杀)
        cross_peers=cfg.cross_peers,
        selection_v2=cfg.selection_v2,
        reveal_holdout=bool(payload.get("final_generation", True)),
        live_entry_gate=cfg.live_entry_gate,
        plan=plan,
        head_trim=head_trim,
        execution_model=cfg.execution_model,
    )
    champion_out = [
        {
            "tokens": c.tokens,
            "text": c.text,
            "metrics": _mark_local_only(_round_metrics(c.metrics), c.tokens),
            "composite": c.composite,
        }
        for c in champions
    ]
    if v2 and payload.get("final_generation", True):
        _reveal_v2_holdout(champion_out, payload, full_bars, cfg.cost)
    if v2:
        # 有界多样性档案(方案 §8.1):取代裸截前 60——头部同质变体占满时,
        # 后部互补候选(不同族/复杂度/换手)仍保留跨代传递;只用训练指标。
        from factor_lab.archive import BoundedArchive

        archive = BoundedArchive()
        archive.extend(best_seen)
        return json.dumps(
            {
                "champions": champion_out,
                "best_seen": [
                    {"composite": c, "tokens": t, "metrics": _round_metrics(m)}
                    for c, t, m in archive.to_payload()
                ],
            },
            ensure_ascii=False,
            default=str,
        )
    # best_seen 裁剪:_dedup_top 的 shortlist 只取 max(3·top_n, top_n+5) 个,
    # 保留前 60 条足够跨代传递且载荷有界
    best_seen.sort(key=lambda x: x[0], reverse=True)
    return json.dumps(
        {
            "champions": champion_out,
            "best_seen": [
                {"composite": c, "tokens": t, "metrics": _round_metrics(m)}
                for c, t, m in best_seen[:60]
            ],
        },
        ensure_ascii=False,
        default=str,
    )
