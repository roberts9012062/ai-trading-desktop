import type { Hunter } from "@/lib/hunter/api"
import { colorForPnl, formatProfitAmount } from "@/components/ai-trading/profit/profit-bar-data"

/** The group's server totals cover all historical opportunities, not just the latest 100 rows. */
export function HunterProfitSummary({ hunter }: { hunter: Hunter }): React.JSX.Element {
  const realized = Number(hunter.runtime.realized ?? 0)
  const unrealized = Number(hunter.runtime.unrealized ?? 0)
  const total = realized + unrealized
  const percent = hunter.capital > 0 ? Math.abs(total) / hunter.capital * 100 : 0
  return <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/50 p-3" aria-label="猎手总收益柱" data-testid="hunter-total-profit">
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[var(--text-secondary)]">总净收益 · 全部子任务</span>
      <strong className={`font-num ${total >= 0 ? "text-up" : "text-down"}`}>{formatProfitAmount(total)} USDT</strong>
    </div>
    <div className="relative mt-2 h-6 rounded bg-white/5 overflow-hidden">
      <div className="absolute inset-y-1 left-0 rounded transition-[width] duration-300" style={{ width: total === 0 ? 0 : `${Math.max(3, Math.min(100, percent))}%`, background: colorForPnl(total) }} />
    </div>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
      <span>已实现 {formatProfitAmount(realized)}</span><span>浮盈 {formatProfitAmount(unrealized)}</span>
      <span>净收益率 {hunter.capital > 0 ? (total / hunter.capital * 100).toFixed(2) : "0.00"}%</span>
      <span>完成 {hunter.stats.trades} 笔 · 持仓任务 {hunter.opportunities.filter(o => !o.finished_at).length}</span>
    </div>
  </div>
}
