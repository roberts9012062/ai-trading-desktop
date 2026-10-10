export interface TaskSlots {
  base: number
  gift: number
  vip: number
  total: number | null
  used: number
  available: number | null
  close_only: number
  unlimited: boolean
}

export function slotSummary(slots: TaskSlots): string {
  if (slots.unlimited) return `任务槽：已用 ${slots.used} / 不限`
  return `任务槽：已用 ${slots.used} / ${slots.total}（基础 ${slots.base}＋永久赠送 ${slots.gift}＋VIP ${slots.vip}）`
}
export function slotSourceLabel(source?: string): string {
  return ({ base: "基础免费槽", gift: "永久赠送槽", vip: "VIP 任务槽", legacy: "待回收任务槽" } as Record<string, string>)[source ?? ""] ?? ""
}
