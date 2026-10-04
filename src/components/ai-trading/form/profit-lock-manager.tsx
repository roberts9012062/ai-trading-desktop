import { useEffect, useMemo, useRef, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ProfitLockSettings } from "./profit-lock-settings"
import { liveProfitLockConfig, liveProfitLockDraft } from "@/lib/profit-lock"
import { profitLockTargets } from "@/lib/profit-lock-targets"
import { useAITradingStore } from "@/stores/ai-trading"
import { useHunterStore } from "@/stores/hunter"
import { useAuthStore } from "@/stores/auth"

/** Page-level entry; all saves use the existing narrow profit-lock endpoints. */
export function ProfitLockManager() {
  const tasks = useAITradingStore(s => s.tasks)
  const groups = useHunterStore(s => s.groups)
  const targets = useMemo(() => profitLockTargets(tasks, groups), [tasks, groups])
  const owner = useAuthStore(s => `${s.user?.id ?? ""}:${s.user?.trading_mode ?? ""}`)
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState("")
  const [draft, setDraft] = useState(() => liveProfitLockDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const mounted = useRef(true)
  const target = targets.find(t => t.key === key)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { generation.current++; setOpen(false); setBusy(false); setError(""); setKey("") }, [owner])

  function choose(next: string) {
    setKey(next)
    setDraft(liveProfitLockDraft(targets.find(t => t.key === next)?.config))
    setError("")
  }
  async function save() {
    if (busy) return
    // Check the latest store snapshot, including removals during polling.
    const current = profitLockTargets(useAITradingStore.getState().tasks, useHunterStore.getState().groups).find(t => t.key === key)
    if (!current) { setError("所选任务已结束或移除，请重新选择。"); return }
    setBusy(true); setError("")
    const started = generation.current
    const active = () => mounted.current && started === generation.current
    try {
      const config = liveProfitLockConfig(draft)
      if (current.kind === "hunter") await useHunterStore.getState().setProfitLock(current.id, config)
      else await useAITradingStore.getState().setProfitLock(current.id, config)
      if (active()) setOpen(false)
    } catch (e) { if (active()) setError(e instanceof Error ? e.message : "锁利设置保存失败") }
    finally { if (active()) setBusy(false) }
  }
  return <>
    <Button type="button" size="sm" variant="outline" onClick={() => {
      const selected = useAITradingStore.getState().selectedTaskId
      choose(targets.find(t => t.kind === "task" && t.id === selected)?.key ?? targets[0]?.key ?? "")
      setOpen(true)
    }}><ShieldCheck className="w-3.5 h-3.5" />锁利设置</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader><DialogTitle>锁利设置</DialogTitle><DialogDescription>选择运行、暂停或仍有持仓的任务，设置自动挡或个人模板。保存后由服务器执行，其他止盈止损规则继续生效。</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
          {targets.length > 0 ? <>
            <div className="space-y-1"><Label htmlFor="profit-lock-target">应用到任务</Label>
              <select id="profit-lock-target" disabled={busy} value={target ? key : ""} onChange={e => choose(e.target.value)} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs">
                {!target && <option value="">请选择任务</option>}
                {targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <p className="text-[11px] text-[var(--text-muted)]">“已锁利”表示已保存并开启锁利；括号显示运行状态，等待激活时尚未生成锁利线。</p>
            </div>
            {target && <fieldset disabled={busy} className="min-w-0" key={key}>
              <ProfitLockSettings value={draft} onChange={setDraft} />
              <p className="mt-3 text-xs text-[var(--text-muted)]">{target.kind === "hunter" ? "应用到该猎手当前未结束的交易任务及后续新机会。" : "仅应用到所选任务，运行状态保持不变。"}首次开启从当前净盈利开始追踪；已锁住的利润线不会降低。已提交的平仓委托不会因关闭锁利而撤销。</p>
            </fieldset>}
          </> : <p className="text-sm text-[var(--text-muted)]">当前没有可设置的任务。创建 AI、量化交易或多周期猎手后，可在这里设置锁利；创建时也可直接选择锁利模板。</p>}
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button validateNumbers type="button" disabled={busy || !target} onClick={() => void save()}>{busy ? "保存中…" : "保存并生效"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>
}
