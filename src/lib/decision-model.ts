/**
 * 决策模型（TypeSafe Jev System One）识别与过滤
 *
 * Jev 是决策模型（返回带概率的结构化判断，无对话端点）：
 * - 只能在「创建量化交易 → 决策模型」中使用
 * - AI 交易 / 回测合成 / 因子分析等对话场景一律筛掉
 */

import type { AIModel } from "@/types"

/** 是否决策模型：渠道为 jev 或能力标记 decision */
export function isDecisionModel(m: AIModel): boolean {
  return (
    (m.provider_api_type ?? "") === "jev" ||
    (m.capabilities ?? []).includes("decision")
  )
}

/** 对话场景模型列表：筛掉决策模型 */
export function chatModelsOnly(list: AIModel[]): AIModel[] {
  return list.filter((m) => !isDecisionModel(m))
}

/** 决策场景模型列表：只留决策模型（量化交易·决策模式） */
export function decisionModelsOnly(list: AIModel[]): AIModel[] {
  return list.filter((m) => isDecisionModel(m))
}
