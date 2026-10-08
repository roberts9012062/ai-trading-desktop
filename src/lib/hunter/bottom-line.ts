import type { Hunter, HunterBottomLine } from "./api"
import type { AITradingTask } from "../ai-trading-api"
import { EMPTY_RULE_FORM, type RuleFormState } from "@/components/ai-trading/form/create-task-rules"

export function hunterBottomRules(hunter: Hunter): RuleFormState {
  const c = hunter.config
  const usesBottom = c.strategy_version === "hunter-pivot" || c.strategy_version === "hunter-rebound" || c.strategy_version === "hunter-macd-ma20" || Boolean(c.bottom_line_revision)
  const tp = usesBottom ? c.max_profit_pct : null, sl = usesBottom ? c.max_loss_pct : null
  return { ...EMPTY_RULE_FORM, bottomTpOn: tp != null, bottomTpPct: String(tp ?? 20), bottomSlOn: sl != null, bottomSlPct: String(sl ?? 10) }
}
/** Only reliable current position snapshots can warn about a threshold breach. */
export function bottomBreaches(hunter: Hunter, tasks: AITradingTask[], bottom: HunterBottomLine): string[] {
  const ids = new Set(hunter.opportunities.filter(o => !o.finished_at).map(o => o.task_id))
  return tasks.flatMap(t => {
    if (!ids.has(t.id) || t.position_sync_status || !(t.position_qty! > 0) || !(t.position_margin! > 0) || !Number.isFinite(t.position_unrealized)) return []
    const roi = t.position_unrealized! / t.position_margin! * 100
    return (bottom.max_profit_pct != null && roi >= bottom.max_profit_pct) || (bottom.max_loss_pct != null && roi <= -bottom.max_loss_pct) ? [`${t.symbol.toUpperCase()} 当前收益率 ${roi.toFixed(2)}%`] : []
  })
}
