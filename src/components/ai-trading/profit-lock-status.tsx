import { ShieldCheck } from "lucide-react"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { profitLockStatus } from "@/lib/profit-lock-status"
import { cn } from "@/lib/utils"

export function TaskProfitLockStatus({ task }: { task: AITradingTask }) {
  const view = profitLockStatus(task)
  if (!view) return null
  return <div aria-label="任务锁利状态" className={cn("mt-2 rounded-md border px-2 py-1.5 text-[11px] space-y-1", view.tone === "active" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : view.tone === "warning" ? "border-amber-500/30 bg-amber-500/10 text-amber-400" : "border-[var(--border)] text-[var(--text-muted)]")}>
    <div className="flex items-center gap-1 font-medium"><ShieldCheck className="w-3 h-3 shrink-0" />{view.label}</div>
    <p className="break-words">{view.detail}</p>
  </div>
}
