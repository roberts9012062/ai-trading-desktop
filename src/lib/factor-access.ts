import type { FactorMetrics } from "./factor-lab-api"

export function isResearchOnlyFactor(tokens: readonly number[], metrics?: Partial<FactorMetrics> | null): boolean {
  return metrics?.research_only === true || metrics?.data_channel === "gate_usdt"
    || tokens.some((t) => t >= 52 && t < 64)
}

export function requiresLocalFactorEngine(tokens: readonly number[], metrics?: Partial<FactorMetrics> | null): boolean {
  return metrics?.local_only === true || tokens.some((t) => (t >= 36 && t < 64) || t >= 104)
}

export const RESEARCH_FACTOR_MESSAGE = "该因子依赖尚未接入实盘的直连数据，暂仅支持本地研究，不支持实盘收藏或挂载"

/** AI task factor_signal is produced by the server; local mining does not change that. */
export function serverFactorBlockReason(tokens: readonly number[], metrics?: Partial<FactorMetrics> | null): string | null {
  if (isResearchOnlyFactor(tokens, metrics)) return RESEARCH_FACTOR_MESSAGE
  if (requiresLocalFactorEngine(tokens, metrics)) return "该公式可收藏用于本地回放，但 AI 任务的服务端因子信号不支持本地专属公式"
  return null
}
