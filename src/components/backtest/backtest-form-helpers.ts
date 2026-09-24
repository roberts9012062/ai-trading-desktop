/** 回测表单校验纯函数 */

import type { AiFundStyleState } from "@/components/ai-trading/form/ai-fund-style-fields"
import {
  validateQuantParams,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import { validateBacktestRange } from "@/components/backtest/timeframe-limits"

export interface BacktestFormInput {
  symbol: string
  startDate: string
  endDate: string
  timeframe: string
  mode: "quant" | "ai"
  modelRowId: string
  fundStyle: AiFundStyleState
  quant: QuantParamsState
  /** 启用多段回测（仅分钟周期） */
  multiSegment?: boolean
  segmentCount?: number
}

/** 校验回测表单；通过返回 null，否则返回错误文案 */
export function validateBacktestForm(input: BacktestFormInput): string | null {
  if (!input.symbol.trim()) return "请选择品种"
  if (!input.startDate || !input.endDate) return "请选择回测起止日期"
  const rerr = validateBacktestRange(input)
  if (rerr) return rerr
  if (input.mode === "ai" && !input.modelRowId) return "请选择 AI 模型"
  if (
    input.mode === "ai" &&
    input.fundStyle.customPromptEnabled &&
    !input.fundStyle.customPrompt.trim()
  ) {
    return "已启用用户提示词，请填写内容"
  }
  if (input.mode === "quant") {
    const qErr = validateQuantParams(input.quant)
    if (qErr) return qErr
  }
  return null
}
