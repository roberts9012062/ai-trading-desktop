import { TIMEFRAME_SECONDS } from "./spec"
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
  risk?: Partial<ShortlineRisk>
  decision?: Partial<ShortlineDecision>
  evalVersion?: "shortline-eval-v1" | "shortline-eval-v2"
}

export interface ShortlineDecision {
  threshold: number
  confirm_steps: number
  stale_multiplier: number
  max_actions_per_hour: number
  max_actions_per_bar: number
  exit_threshold?: number
  neutral_exit_steps?: number
  stop_reentry_new_signal?: boolean
  market_execution?: boolean
  trailing_start_pct?: number
  trailing_giveback_pct?: number
}
export interface ShortlineRisk { max_notional_usdt: number, daily_loss_limit_usdt: number, mode: "paper" | "live" }

export interface ShortlineTaskPayload {
  task_type: "shortline_factor_v1"
  symbol: string
  timeframe: ShortlineTimeframe
  cadence_seconds: CadenceSeconds
  warmup_bars: number
  eval_version: string
  champions: Array<{ id: number, tokens: number[], weight: number }>
  decision: ShortlineDecision
  risk: ShortlineRisk
  fixture_manifest: string
}

/** 服务器仍无数据源的桌面特征（factor-access.SERVER_MISSING_FEATS 同源） */
export const SERVER_MISSING_FEATS = new Set([55, 57, 58])

/**
 * 服务器 3s 级数据源只有 OHLCV(+时间):衍生品/跨资产/直连特征不可挂载。
 * 与服务端 shortline/contract.py 的 SERVER_FEATURE_WHITELIST(_DERIV_DEPENDENT
 * 排除集)同源——两端不一致时,桌面放行的载荷会被服务器 400 拒收。
 * id 按 pykernel FEATURE_NAMES 计算(62 特征表,两端同步演进)。
 */
export const SERVER_BLOCKED_FEATS: ReadonlyMap<number, string> = new Map([
  [14, "OI_CHG"], [15, "OI_PV"], [16, "VOL_OI"],
  [27, "OI_PC"], [28, "OI_CHG5"], [29, "OI_CHG20"], [30, "VOL_OI_MA"],
  [52, "FUNDING_RATE"], [53, "FUNDING_DELTA"], [54, "TAKER_IMBALANCE"],
  [55, "QUOTE_ILLIQ20"], [56, "ACCOUNT_LS_RATIO"], [57, "LIQUIDATION_IMBALANCE"],
  [58, "AVG_TRADE_QUOTE"], [59, "FUNDING_MEAN24"], [60, "OI_TREND24"], [61, "TAKER_IMB24"],
])

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
      } else if (SERVER_BLOCKED_FEATS.has(t)) {
        reasons.push(
          `token ${t}（${SERVER_BLOCKED_FEATS.get(t)}）: 服务器 3s 级数据源只有 K 线 OHLCV,` +
          "衍生品/直连特征不可挂载(与服务端白名单同源)",
        )
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
  const spanSec = TIMEFRAME_SECONDS[timeframe]
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
    eval_version: input.evalVersion ?? SHORTLINE_EVAL_VERSION,
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
