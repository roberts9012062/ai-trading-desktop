import { useState } from "react"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import { showAlert } from "@/stores/dialog"
import { TaskCloseButton } from "./task-close-button"

/** Shared control for profit comparison cards and hunter child tasks. */
export function TaskCloseControl({ task }: { task: AITradingTask }) {
  const closePosition = useAITradingStore(s => s.closePosition)
  const [busy, setBusy] = useState(false)
  async function close(): Promise<void> {
    if (busy) return
    setBusy(true)
    try { await closePosition(task.id) }
    catch (error) { await showAlert({ title: "平仓失败", description: error instanceof Error ? error.message : "请稍后重试", variant: "destructive" }) }
    finally { setBusy(false) }
  }
  return <div className="mt-2" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <TaskCloseButton task={task} busy={busy} closing={busy} onClose={() => void close()} />
  </div>
}
