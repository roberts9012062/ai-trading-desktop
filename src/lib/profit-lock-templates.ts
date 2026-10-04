import type { ProfitLockConfig } from "./ai-trading-api"
import { buildProfitLockConfig, profitLockFromConfig, type ProfitLockFormState } from "./profit-lock"

export interface ProfitLockTemplate {
  id: string
  name: string
  config: ProfitLockConfig
  created_at: string
  updated_at: string
}
export const BUILTIN_PROFIT_LOCK_TEMPLATES: ProfitLockTemplate[] = [
  { id: "builtin-auto", name: "自动锁利 · 5%激活 / 冷却1次", config: { enabled: true, mode: "auto", unit: "percent", activation: 3, giveback: 1, cooldown_signals: 1 }, created_at: "", updated_at: "" },
  { id: "builtin-manual", name: "手动锁利 · 3%激活 / 回撤1% / 冷却1次", config: { enabled: true, mode: "manual", unit: "percent", activation: 3, giveback: 1, cooldown_signals: 1 }, created_at: "", updated_at: "" },
]
/** Copy parameters only. A selection never changes the task's independent switch. */
export function applyProfitLockTemplate(template: ProfitLockTemplate, enabled: boolean): ProfitLockFormState {
  return { ...profitLockFromConfig(template.config), enabled }
}
export function profitLockTemplateBody(name: string, form: ProfitLockFormState) {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 80) throw new Error("模板名称须为1～80个字符")
  return { name: trimmed, config: buildProfitLockConfig({ ...form, enabled: true })! }
}
export function matchesProfitLockTemplate(form: ProfitLockFormState, template: ProfitLockTemplate): boolean {
  try {
    const config = buildProfitLockConfig({ ...form, enabled: true })!
    return (Object.keys(config) as (keyof ProfitLockConfig)[]).every(key => config[key] === template.config[key])
  } catch { return false }
}
