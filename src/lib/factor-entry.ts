import type { FactorEntryMode, FactorEntryState } from './ai-trading-api'

export interface FactorEntryTask {
  strategy_params?: unknown
  factor_entry?: FactorEntryState | null
  position_qty?: number | null
  position_direction?: string | null
}
export const ENTRY_MODE_LABEL: Record<FactorEntryMode,string> = {steady:'稳健模式',aggressive:'激进模式'}
export function entryModeOf(task: FactorEntryTask): FactorEntryMode {
  const configured=(task.strategy_params as Record<string,unknown>|null)?.entry_mode
  return task.factor_entry?.mode ?? (configured==='steady'?'steady':'aggressive')
}
export function entryObservationKey(task: FactorEntryTask): string {
  return JSON.stringify([entryModeOf(task),task.factor_entry?.pending_mode??null,(task.position_qty??0)>0,task.position_direction??null])
}
function region(score: number): number {
  return score>.7?2:score>.3?1:score<-.7?-2:score<-.3?-1:0
}
/** Report reset/crossing events; unchanged neutral scores need no server work. */
export function needsEntryObservation(task: FactorEntryTask, score: number, previous?: number): boolean {
  return (entryModeOf(task)==='steady'||!!task.factor_entry?.pending_mode) &&
    (previous===undefined || region(score)!==region(previous))
}
