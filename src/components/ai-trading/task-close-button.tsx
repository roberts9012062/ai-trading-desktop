import { CircleDollarSign, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AITradingTask } from "@/lib/ai-trading-api"

export function TaskCloseButton({ task, busy = false, closing = false, marketClosed = false, onClose }: {
  task: AITradingTask; busy?: boolean; closing?: boolean; marketClosed?: boolean; onClose: () => void
}) {
  const held = Boolean(task.has_open_position || Number(task.position_qty ?? 0) > 0)
  const pending = closing || Boolean(task.profit_lock_state?.closing && !task.profit_lock_state.closed)
  const cooldown = Math.max(1, task.close_rules?.profit_lock?.cooldown_signals ?? 1)
  const title = pending ? "平仓已提交，等待成交确认" : !held ? "当前任务没有持仓" : marketClosed ? "停盘期间不可平仓" : `市价平掉该任务全部持仓，成交后锁利冷却 ${cooldown} 次有效开仓信号`
  return <Button type="button" size="sm" variant="outline" disabled={busy || pending || !held || marketClosed}
    onClick={onClose} title={title} aria-label={pending ? "一键平仓处理中" : "一键平仓"}
    className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:border-amber-400/50 hover:bg-amber-500/20 hover:text-amber-200">
    {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDollarSign className="h-3.5 w-3.5" />}
    {pending ? "平仓中…" : "一键平仓"}
  </Button>
}
