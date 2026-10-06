import type { AITradingTask } from "@/lib/ai-trading-api"

export function TaskLossCooldownStatus({ task }: { task: AITradingTask }): React.JSX.Element | null {
  const state = task.loss_cooldown_state
  if (task.loss_cooldown_enabled === false || state?.enabled === false) return null
  const count = state?.loss_count ?? 0
  const limit = task.loss_cooldown_limit ?? state?.limit ?? 2
  const until = state?.reset_at ? new Date(state.reset_at).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }) : "次日 06:00"
  return <div className={`mt-2 rounded-md border px-2 py-1 text-[11px] ${state?.active || state?.error
    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
    : "border-[var(--border)] text-[var(--text-muted)]"}`}>
    {state?.active ? `冷静期 · 本日亏损 ${count} 次 · 北京时间 ${until} 解封`
      : state?.error ? `冷静期等待对账 · ${state.error}`
      : `亏损保护 ${count}/${limit} 次 · 北京时间 06:00 重置`}
  </div>
}
