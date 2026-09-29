/** 因子实验室纯辅助函数 —— 不含 React 状态 */

import { SERVER_MISSING_FEATS, desktopTokensToServerV3 } from "@/lib/factor-access"

import type {
  Champion,
  FactorFavoriteItem,
  FactorHistoryItem,
} from "@/lib/factor-lab-api"
import type { CreateTaskPayload } from "@/lib/ai-trading-api"
import { CURRENT_KERNEL_VERSION } from "@/lib/kernel-version"
import { isCurrentNativeMetrics } from "@/lib/native-engine/version"
import type { SearchFormPayload } from "../factor-search-form"

/** 默认搜索请求（回退用）
 *
 * 防过拟合默认开启推荐配置：训练比例 0.7 + walk-forward 3 折。
 * 与 factor-search-form 的 state 默认值、后端 schema 默认值保持一致，
 * 三处同源避免行为分裂。
 */
export function defaultSearchPayload(
  symbol: string,
  timeframe: string,
): SearchFormPayload {
  return {
    symbol,
    timeframe,
    population: 30,
    generations: 15,
    top_n: 10,
    seed: 42,
    cost: null,
    use_llm_coach: false,
    model_row_id: null,
    train_ratio: 0.7,
    test_recent_bars: 0,
    walk_forward_folds: 3,
  }
}

/** 防过拟合三参组装：启用位决定透传数值还是全 0（全 0 = 内核防护关闭）
 *
 * 启用位必须是独立状态，与「防过拟合（高级）」面板的折叠展开无关——
 * 曾经直接用折叠状态当启用位，面板默认收起导致防护以 0 发出、UI 却显示已开启。
 */
export function antiOverfitPayload(
  on: boolean,
  trainRatio: number,
  testRecentBars: number,
  walkForwardFolds: number,
): Pick<SearchFormPayload, "train_ratio" | "test_recent_bars" | "walk_forward_folds"> {
  return on
    ? {
        train_ratio: trainRatio,
        test_recent_bars: testRecentBars,
        walk_forward_folds: walkForwardFolds,
      }
    : { train_ratio: 0, test_recent_bars: 0, walk_forward_folds: 0 }
}

/** AI 交易建任务 payload（因子策略） */
export function buildFactorTaskPayload(
  symbol: string,
  timeframe: string,
  tokens: number[],
): CreateTaskPayload {
  return {
    name: `因子·${symbol}·${timeframe}`,
    model_row_id: null,
    strategy_type: "factor",
    // 提交服务器：桌面谱系 token 转 v3 编码（本地回放/收藏不转换）
    strategy_params: { factor_tokens: desktopTokensToServerV3(tokens) },
    symbol,
    symbol_name: "",
    timeframe,
    side_mode: "both",
    position_mode: "fixed_qty",
    fixed_qty: 1,
    close_rules: {
      pnl_pct: null,
      total_pnl_pct: null,
      // 日线因子持仓以日为单位，日内强平会推翻回测的持仓假设；
      // 分钟因子维持日内平仓（与回测 bar 内持仓假设一致）
      session_close: timeframe !== "1d",
      ai_auto: false,
    },
    stop_rules: { loss_pct: null, loss_amount: null, ai_auto: false },
    close_on_stop: true,
    auto_start: false,
  }
}

/** AI 交易建任务 payload（组合因子：2-5 个低相关因子等权） */
export function buildComboTaskPayload(
  symbol: string,
  timeframe: string,
  tokenGroups: number[][],
): CreateTaskPayload {
  const base = buildFactorTaskPayload(symbol, timeframe, tokenGroups[0] ?? [])
  return {
    ...base,
    name: `组合(${tokenGroups.length})·${symbol}·${timeframe}`,
    // factor_tokens 传 list of lists = 组合形态；省略 factor_weights = 等权
    strategy_params: { factor_tokens: tokenGroups.map(desktopTokensToServerV3) },
  }
}

/** 旧口径判定(发布前清单第 7 步):版本戳缺失或与当前内核不一致 → stale_kernel。
 *  只对历史/收藏恢复的记录生效;当次搜索的冠军是现行口径,不打标。 */
function deriveStaleKernel(metrics: unknown): boolean {
  const v = (metrics as { kernel_version?: string } | undefined)?.kernel_version
  if (v === "native-gpu-v1") return !isCurrentNativeMetrics(metrics as Record<string, unknown>)
  return v !== CURRENT_KERNEL_VERSION
}

/**
 * 标准特征空间大小(与服务端 FEATURE_NAMES 对齐的部分)。id ∈ [36, 64) 为桌面端
 * 本地专属特征批次(features.py「桌面端本地专属批次」),含此类 token 的公式
 * 服务端无法执行。须与内核 factor_local.py 的 STANDARD_FEAT_COUNT 同步维护。
 * 64 = FEAT_OFFSET:算子 token 从 64 起,判定必须排除算子区间。
 */
export const STANDARD_FEAT_COUNT = 36
const FEAT_OFFSET = 64

/** 本地专属公式判定:2026-09-28 起服务器 v3 已补齐桌面谱系算子/特征,
 *  仅服务器无数据源的直连特征(逐笔/强平类,SERVER_MISSING_FEATS)仍需
 *  本地引擎执行。metrics.local_only 是按旧服务器能力打的存量标,不再
 *  作为依据(内核按旧口径打的标会把已支持的特征也拦成 local_only)。 */
export function isLocalOnly(tokens: number[] | null | undefined, _metrics?: unknown): boolean {
  return !!tokens?.some((t) => SERVER_MISSING_FEATS.has(t))
}

/** 默认空指标（补齐字段用） */
export function emptyMetrics(composite: number): Champion["metrics"] {
  return {
    ann_ret: 0,
    sortino: 0,
    calmar: 0,
    ts_ic: 0,
    symmetry: 0,
    turnover_q: 0,
    oos_sortino: 0,
    oos_mult: 1,
    oos_negative: false,
    consistency: 0,
    composite,
    avg_turnover: 0,
    exposure: 0,
  }
}

/** 历史记录 → Champion(补齐指标)
 *
 * P1-5:改为「兜底 + 全量透传」——原白名单式复制会丢 overfit_warning,
 * 从历史面板重新选中过拟合因子时三处拦截(挂实盘/收藏/进组合)全部失效;
 * oos_conservative/pbo_proxy/regime/trials/ts_ic_5 等字段同样不再丢失。
 */
export function championFromHistory(item: FactorHistoryItem): Champion {
  const m = (item.metrics ?? {}) as Champion["metrics"]
  return {
    tokens: item.tokens,
    text: item.text,
    composite: item.composite,
    metrics: {
      ...emptyMetrics(item.composite),
      ...m,
      composite: Number(m.composite ?? item.composite),
      stale_kernel: deriveStaleKernel(m),
    } as Champion["metrics"],
  }
}

/** 收藏 → Champion(同样按版本戳判定旧口径) */
export function championFromFavorite(item: FactorFavoriteItem): Champion {
  return {
    tokens: item.tokens,
    text: item.text,
    composite: item.composite ?? 0,
    metrics: {
      ...emptyMetrics(item.composite ?? 0),
      ...(item.metrics as object),
      stale_kernel: deriveStaleKernel(item.metrics),
    } as Champion["metrics"],
  }
}
