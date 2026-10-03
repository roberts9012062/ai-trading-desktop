import type { FactorMetrics } from "./factor-lab-api"

/**
 * 桌面端因子 → 服务器挂载的编码出口（唯一职责：token id 映射）。
 *
 * 服务器已按 v3 双编码空间补齐桌面端谱系（算子 40-50 对齐、特征
 * 36-61 append 到 v3 id 57-82）：桌面特征 <36 不变、36-61 → +21，
 * 桌面算子（>=64）→ +64（服务器 v3 算子基址 128，op id 与桌面同序）。
 * 纯函数、幂等（已含 >=128 的输入原样返回）；不触碰任何本地计算
 * ——挖掘/评分/回测/收藏始终用桌面编码，仅在提交服务器任务时转换。
 */
export function desktopTokensToServerV3(tokens: readonly number[]): number[] {
  // 整条公式级 v3 判定（与服务器 remap_desktop_to_v3 同款）：v3 公式必含
  // >=128 的算子 token，v3 特征 57-61 与桌面特征 id 数值重叠，必须先判
  // 整条再映射，否则已转换的公式会被二次平移
  if (tokens.some((t) => t >= 128)) return [...tokens]
  return tokens.map((t) => {
    if (t >= 64) return t + 64
    if (t >= 36 && t < 62) return t + 21
    return t
  })
}

/** 服务器仍无数据源的桌面直连特征（本地谱系 id）：
 *  55 QUOTE_ILLIQ20 / 57 LIQUIDATION_IMBALANCE / 58 AVG_TRADE_QUOTE
 *  需要逐笔成交额/笔数与强平流，服务器 deriv 管道不采集 → 只能本地回放。
 *  其余直连特征（funding/taker/lsr/OI 族）服务器富化管道已供给。 */
export const SERVER_MISSING_FEATS = new Set([55, 57, 58])

function hasServerMissingFeature(tokens: readonly number[]): boolean {
  // 能力判定与编码出口使用相同的整条公式判据。v3 的 57/58 是
  // STREAK/VWAP_DEV，不能按桌面 57/58 误读为强平/逐笔输入。
  const v3 = tokens.some(t => t >= 128)
  return tokens.some(t => v3
    ? t >= 57 && t < 83 && SERVER_MISSING_FEATS.has(t - 21)
    : SERVER_MISSING_FEATS.has(t))
}

/** 服务端信号的数据能力判定；不代表配方不能收藏。 */
export function isResearchOnlyFactor(tokens: readonly number[], _metrics?: Partial<FactorMetrics> | null): boolean {
  // 2026-09-28 起服务器 v3 已供给 funding/taker/lsr/OI 族直连特征，
  // 仅剩逐笔/强平类无源特征需本地研究。研究渠道是数据来源记录，
  // 任务使用服务器当前行情及富化管道；不能把 gate_usdt 来源或旧的
  // research_only/local_only 标记当作永久的执行能力限制。
  return hasServerMissingFeature(tokens)
}

export function requiresLocalFactorEngine(tokens: readonly number[], metrics?: Partial<FactorMetrics> | null): boolean {
  // 2026-09-28 起服务器 v3 已补齐桌面谱系算子与特征：
  // 算子 >=104、特征 36-54/59-61 均可挂载（desktopTokensToServerV3 转换）；
  // 仅服务器无数据源的 3 个直连特征仍需本地引擎
  // local_only 与 research_only 都可能是旧能力标记，实际依赖才是依据。
  return isResearchOnlyFactor(tokens, metrics)
}

export const RESEARCH_FACTOR_MESSAGE = "该配方可以收藏，但其逐笔成交或强平数据尚未接入服务器，暂不能挂载服务器任务；请替换缺少数据的成员"

/** AI task factor_signal is produced by the server; local mining does not change that. */
export function serverFactorBlockReason(tokens: readonly number[], metrics?: Partial<FactorMetrics> | null): string | null {
  return requiresLocalFactorEngine(tokens, metrics) ? RESEARCH_FACTOR_MESSAGE : null
}
