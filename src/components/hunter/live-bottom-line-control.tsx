import { useEffect, useRef, useState } from "react"
import { Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { CreateTaskRules, buildBottomPayload } from "@/components/ai-trading/form/create-task-rules"
import { useHunterStore } from "@/stores/hunter"
import { useAITradingStore } from "@/stores/ai-trading"
import { useAuthStore } from "@/stores/auth"
import type { Hunter } from "@/lib/hunter/api"
import { hunterBottomRules, bottomBreaches } from "@/lib/hunter/bottom-line"

export function LiveBottomLineControl({ hunter, disabled = false }: { hunter: Hunter; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("")
  const [draft, setDraft] = useState(() => hunterBottomRules(hunter))
  const setBottomLine = useHunterStore(s => s.setBottomLine)
  const tasks = useAITradingStore(s => s.tasks)
  const owner = useAuthStore(s => s.user?.id)
  const generation = useRef(0), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { generation.current++; setOpen(false); setBusy(false); setError("") }, [hunter.id, owner])
  // Keep edits while the task/group polling updates current positions.
  let breaches: string[] = []
  try { breaches = bottomBreaches(hunter, tasks, buildBottomPayload(draft)) } catch { /* validation shown on save */ }
  async function save() {
    if (busy) return
    setBusy(true); setError("")
    const started = generation.current
    const active = () => mounted.current && started === generation.current
    try {
      const { max_profit_pct, max_loss_pct } = buildBottomPayload(draft)
      await setBottomLine(hunter.id, { max_profit_pct, max_loss_pct })
      if (active()) setOpen(false)
    } catch (e) { if (active()) setError(e instanceof Error ? e.message : "盈亏兜底保存失败") }
    finally { if (active()) setBusy(false) }
  }
  return <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <Button type="button" size="sm" variant="outline" disabled={disabled || busy} title="运行和持仓中随时调整盈亏兜底" onClick={() => { setDraft(hunterBottomRules(hunter)); setError(""); setOpen(true) }}><Shield className="w-3.5 h-3.5 mr-1" />盈亏兜底</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader><DialogTitle>动态盈亏兜底 · {hunter.name}</DialogTitle><DialogDescription>保存后应用到所有未结束的子任务及后续新单，由服务器下一轮评估生效。</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
          <fieldset disabled={busy}><CreateTaskRules value={draft} onChange={setDraft} showAiOptions={false} bottomOnly showCooldown={false} checkSeconds={5} /></fieldset>
          <p className="text-xs text-[var(--text-muted)]">可分别关闭或修改兜底止盈、止损。按当前持仓保证金收益率计算；已达到新阈值的持仓会在保存后平仓。锁利及枢轴／结构退出继续生效，已提交的平仓不会撤销。</p>
          {breaches.length > 0 && <p role="alert" className="text-xs text-amber-400">{breaches.join("；")}，已达到新兜底阈值，保存后将触发平仓。</p>}
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button validateNumbers type="button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : breaches.length ? "保存并触发平仓" : "保存并生效"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
