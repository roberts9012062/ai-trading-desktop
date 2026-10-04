import type { ProfitLockConfig } from "./ai-trading-api"

export interface ProfitLockFormState {
  enabled: boolean
  mode: "auto" | "manual"
  unit: "percent" | "usdt"
  activation: string
  giveback: string
  cooldown: string
}
export const DEFAULT_PROFIT_LOCK: ProfitLockFormState = {
  enabled: false, mode: "auto", unit: "percent", activation: "3", giveback: "1", cooldown: "1",
}
/** Opening the live-task switch defaults to auto; existing enabled rules refill. */
export function liveProfitLockDraft(config?: ProfitLockConfig | null): ProfitLockFormState {
  return config?.enabled ? profitLockFromConfig(config) : { ...DEFAULT_PROFIT_LOCK, enabled: true }
}
export function liveProfitLockConfig(form: ProfitLockFormState): ProfitLockConfig {
  return buildProfitLockConfig(form) ?? { ...buildProfitLockConfig({ ...DEFAULT_PROFIT_LOCK, enabled: true })!, enabled: false }
}
export function profitLockFromConfig(config?: ProfitLockConfig | null): ProfitLockFormState {
  return config ? { enabled: config.enabled, mode: config.mode, unit: config.unit,
    activation: String(config.activation), giveback: String(config.giveback), cooldown: String(config.cooldown_signals) } : { ...DEFAULT_PROFIT_LOCK }
}
export function buildProfitLockConfig(form?: ProfitLockFormState): ProfitLockConfig | undefined {
  if (!form?.enabled) return undefined
  const activation = Number(form.activation), giveback = Number(form.giveback), cooldown = Number(form.cooldown)
  if (!form.cooldown.trim() || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 5) throw new Error("锁利冷却次数须为0～5的整数")
  if (form.mode === "manual") {
    if (!form.activation.trim() || !form.giveback.trim() || !Number.isFinite(activation) || !Number.isFinite(giveback) || activation <= 0 || giveback <= 0 || activation > 100000000 || giveback > 100000000) throw new Error("请输入有效的锁利激活阈值和允许回撤")
    if (form.unit === "percent" && (activation < 3 || giveback < 1)) throw new Error("手动锁利激活最小3%，允许回撤最小1%")
    if (activation <= giveback) throw new Error("锁利激活阈值必须大于允许回撤，确保锁住正利润")
  }
  return { enabled: true, mode: form.mode, unit: form.mode === "auto" ? "percent" : form.unit,
    activation: form.mode === "auto" ? 3 : activation, giveback: form.mode === "auto" ? 1 : giveback,
    cooldown_signals: cooldown }
}
