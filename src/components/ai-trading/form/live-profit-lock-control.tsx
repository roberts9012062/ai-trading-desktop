import { useEffect, useRef, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ProfitLockSettings } from "./profit-lock-settings"
import { liveProfitLockDraft, liveProfitLockConfig } from "@/lib/profit-lock"
import type { ProfitLockConfig } from "@/lib/ai-trading-api"
import { useAuthStore } from "@/stores/auth"

export function LiveProfitLockControl({ targetId, name, config, onSave, disabled = false, hunter = false }: {
  targetId: string; name: string; config?: ProfitLockConfig | null;
  onSave: (config: ProfitLockConfig) => Promise<void>; disabled?: boolean; hunter?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => liveProfitLockDraft(config))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const owner = useAuthStore(s => s.user?.id)
  const mounted = useRef(true)
  const generation = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // Close only on identity changes. Polling must not overwrite unsaved edits.
  useEffect(() => { generation.current++; setOpen(false); setError(""); setBusy(false) }, [targetId, owner])
  async function save() {
    if (busy) return
    setBusy(true); setError("")
    const started = generation.current
    const active = () => mounted.current && started === generation.current
    try {
      await onSave(liveProfitLockConfig(draft))
      if (active()) setOpen(false)
    } catch (e) { if (active()) setError(e instanceof Error ? e.message : "锁利设置保存失败") }
    finally { if (active()) setBusy(false) }
  }
  return <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <Button type="button" size="sm" variant="outline" disabled={disabled || busy} title="运行和持仓中均可设置锁利润" onClick={() => {
      setDraft(liveProfitLockDraft(config)); setError(""); setOpen(true)
    }}><ShieldCheck className="w-3.5 h-3.5 mr-1" />{config?.enabled ? "锁利已开" : "开启锁利"}</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader><DialogTitle>任务锁利 · {name}</DialogTitle><DialogDescription>
          {hunter ? "保存后应用到当前未结束的交易任务和后续新机会。" : "运行和持仓中均可修改；保存后由服务器下一轮评估生效。"}
          任务状态保持不变，其他止盈止损规则继续生效。
        </DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
          <fieldset disabled={busy} className={busy ? "min-w-0 opacity-70" : "min-w-0"}><ProfitLockSettings value={draft} onChange={setDraft} /></fieldset>
          <p className="text-xs text-[var(--text-muted)]">首次开启从当前净盈利开始追踪；已锁住的利润线不会降低。满足锁利平仓条件时由服务器执行，实际收益以成交为准。已提交的平仓委托不会因关闭锁利而撤销。</p>
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存并生效"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
