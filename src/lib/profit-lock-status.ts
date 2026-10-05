import type { AITradingTask } from "./ai-trading-api"

export interface ProfitLockStatusView {
  label: string
  detail: string
  tone: "active" | "waiting" | "warning"
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const money = (value: number) => value > 0 && value < .01 ? "<0.01" : value.toFixed(2)

/** Display the server's net-profit floor; never derive it from gross quote PnL. */
export function profitLockStatus(task: AITradingTask): ProfitLockStatusView | null {
  const config = task.close_rules?.profit_lock
  const state = task.profit_lock_state ?? {}
  const floor = finite(state.locked_net) && state.locked_net > 0 ? state.locked_net : null
  const pct = finite(state.locked_pct) ? `（保证金收益 ${state.locked_pct.toFixed(2)}%）` : ""
  if (state.closing && !state.closed) return { label: state.signal_exit ? "信号失效平仓中" : "锁利平仓中", detail: "已提交平仓，等待成交确认。", tone: "waiting" }
  if (state.signal_exit) {
    if (state.error) return { label: "信号失效止损等待处理", detail: state.error, tone: "warning" }
    if (state.closed && !task.has_open_position && !(task.position_qty && task.position_qty > 0)) return {
      label: "信号失效已平仓", detail: "等待新的枢轴多空信号；已失效的开仓枢轴不会重复使用。", tone: "waiting",
    }
  }
  if (state.manual_exit) {
    if (state.error) return { label: "一键平仓等待处理", detail: state.error, tone: "warning" }
    const cooldown = finite(state.cooldown_remaining) ? Math.max(0, Math.trunc(state.cooldown_remaining)) : 0
    if (state.closed && cooldown > 0) return { label: `锁利冷却 · 剩余 ${cooldown} 次信号`, detail: "一键平仓已成交，冷却期间跳过有效开仓信号；同一信号重复评估不重复计数。", tone: "waiting" }
  }
  if (!config?.enabled) return null
  if (state.error) return { label: "锁利等待处理", detail: state.error, tone: "warning" }
  if (task.status === "paused") return { label: "锁利已开启 · 任务暂停", detail: "恢复运行后继续评估锁利。", tone: "waiting" }
  const held = task.has_open_position || (task.position_qty ?? 0) > 0
  if (held && task.status === "stopped") return { label: "锁利已开启 · 任务已结束", detail: "任务已结束，锁利不再自动评估；请检查剩余持仓。", tone: "warning" }
  if (!held || state.closed) {
    const cooldown = finite(state.cooldown_remaining) ? Math.max(0, Math.trunc(state.cooldown_remaining)) : 0
    return {
      label: cooldown > 0 ? `锁利冷却 · 剩余 ${cooldown} 次信号` : "锁利已开启 · 等待新持仓",
      detail: floor !== null && state.closed ? `上轮锁利线 ${money(floor)} USDT${pct}；新持仓重新计算。` : "持仓并达到净盈利激活阈值后生成锁利线。",
      tone: "waiting",
    }
  }
  if (state.activated && floor !== null) return {
    label: "已锁利",
    detail: `净利润回落至 ${money(floor)} USDT${pct}时锁利平仓。${finite(state.net_profit) ? `当前净利润 ${money(state.net_profit)} USDT。` : ""}`,
    tone: "active",
  }
  const threshold = config.mode === "auto" ? "5.00%" : `${config.activation.toFixed(2)}${config.unit === "usdt" ? " USDT" : "%"}`
  return { label: "锁利已开启 · 等待激活", detail: `净盈利达到 ${threshold} 后激活。${finite(state.net_profit) ? `当前净利润 ${money(state.net_profit)} USDT。` : "等待服务器评估。"}`, tone: "waiting" }
}
