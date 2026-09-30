/**
 * 挂载载荷组装（契约 shortline_factor_v1 §9，字段不得单方变更）+ 白名单校验。
 *
 * 黄金夹具导出带 manifest SHA（服务器 S1 门依赖）；v4 token(115-122)与
 * 服务器无数据源特征在服务器实现对应能力前标记"仅本地"并拒绝挂载。
 */

import { requiredHistoryBars } from "./replay"
import { normWindowForBars } from "./features"
import type { ShortlineBar } from "./forming-bar"
import {
  DECISION_DEFAULTS, RISK_DEFAULTS, SHORTLINE_EVAL_VERSION,
  isShortlineToken, type CadenceSeconds, type ShortlineTimeframe,
} from "./spec"
import { SHORTLINE_TOKEN_OFFSET } from "./spec"

export interface ShortlineMountInput {
  symbol: string
  timeframe: ShortlineTimeframe
  cadence: CadenceSeconds
  /** 待挂载冠军（桌面 token 编码） */
  champions: ReadonlyArray<{ id: number, tokens: readonly number[] }>
  /** 冻结 IC 权重（Σ 不必为 1，组装时归一）；缺省等权 */
  weights?: readonly number[]
  /** 预热 bars 参照（公式窗口推导用；缺省 300） */
  warmupBars?: number
  risk?: Partial<typeof RISK_DEFAULTS>
  decision?: Partial<typeof DECISION_DEFAULTS>
}

export interface ShortlineTaskPayload {
  task_type: "shortline_factor_v1"
  symbol: string
  timeframe: ShortlineTimeframe
  cadence_seconds: CadenceSeconds
  warmup_bars: number
  eval_version: string
  champions: Array<{ id: number, tokens: number[], weight: number }>
  decision: typeof DECISION_DEFAULTS
  risk: typeof RISK_DEFAULTS
  fixture_manifest: string
}

/** 服务器仍无数据源的桌面特征（factor-access.SERVER_MISSING_FEATS 同源） */
export const SERVER_MISSING_FEATS = new Set([55, 57, 58])

export interface MountCheck {
  ok: boolean
  reasons: string[]
  /** v4/仅本地标记（展示用） */
  localOnlyTokens: number[]
}

export function checkMountable(tokensList: ReadonlyArray<readonly number[]>): MountCheck {
  const reasons: string[] = []
  const localOnly: number[] = []
  for (const tokens of tokensList) {
    for (const t of tokens) {
      if (isShortlineToken(t)) {
        localOnly.push(t)
        reasons.push(`token ${t}: v4 订单流特征为桌面本地专属,服务器 FormulaEvaluator 尚未实现(标记"仅本地")`)
      } else if (SERVER_MISSING_FEATS.has(t)) {
        reasons.push(`token ${t}: 服务器无数据源的直连特征(55 QUOTE_ILLIQ20/57 LIQUIDATION_IMBALANCE/58 AVG_TRADE_QUOTE)`)
      }
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], localOnlyTokens: [...new Set(localOnly)] }
}

/** 公式所需预热（含特征/算子/输出归一化窗；下限 300=契约示例值） */
export function requiredWarmupBars(
  tokensList: ReadonlyArray<readonly number[]>,
  timeframe: ShortlineTimeframe,
): number {
  const spanSec = timeframe === "1m" ? 60 : timeframe === "5m" ? 300 : 900
  const estW = Math.max(200, Math.ceil(86400 / spanSec))
  let need = 300
  for (const tokens of tokensList) need = Math.max(need, requiredHistoryBars(tokens, timeframe, estW))
  return need
}

export function buildShortlinePayload(
  input: ShortlineMountInput,
  fixtureManifestSha: string,
): ShortlineTaskPayload {
  const check = checkMountable(input.champions.map((c) => c.tokens))
  if (!check.ok) {
    throw new Error(`挂载校验未通过：${check.reasons.join("；")}`)
  }
  const raw = input.weights ?? input.champions.map(() => 1 / Math.max(1, input.champions.length))
  const sum = raw.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) throw new Error("权重和必须为正")
  return {
    task_type: "shortline_factor_v1",
    symbol: input.symbol,
    timeframe: input.timeframe,
    cadence_seconds: input.cadence,
    warmup_bars: input.warmupBars ?? requiredWarmupBars(input.champions.map((c) => c.tokens), input.timeframe),
    eval_version: SHORTLINE_EVAL_VERSION,
    champions: input.champions.map((c, i) => ({
      id: c.id,
      tokens: [...c.tokens],
      weight: raw[i]! / sum,
    })),
    decision: { ...DECISION_DEFAULTS, ...(input.decision ?? {}) },
    risk: { ...RISK_DEFAULTS, ...(input.risk ?? {}) },
    fixture_manifest: `sha256:${fixtureManifestSha}`,
  }
}

export { SHORTLINE_TOKEN_OFFSET, normWindowForBars }
export type { ShortlineBar }
