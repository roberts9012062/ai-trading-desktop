import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuthStore } from "@/stores/auth"
import { listProfitLockTemplates, saveProfitLockTemplate, deleteProfitLockTemplate } from "@/lib/api"
import { BUILTIN_PROFIT_LOCK_TEMPLATES, applyProfitLockTemplate, matchesProfitLockTemplate, profitLockTemplateBody, type ProfitLockTemplate } from "@/lib/profit-lock-templates"
import type { ProfitLockFormState } from "@/lib/profit-lock"

const changedEvent = "profit-lock-templates-changed"
export function ProfitLockTemplatePicker({ id, value, onChange }: {
  id: string; value: ProfitLockFormState; onChange: (value: ProfitLockFormState) => void
}) {
  const owner = useAuthStore(s => s.user?.id)
  const [data, setData] = useState<{ owner?: string; items: ProfitLockTemplate[] }>({ items: [] })
  const [chosen, setChosen] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let active = true, sequence = 0
    setChosen(""); setName(""); setError(""); setNotice(""); setBusy(false)
    const load = async () => {
      const current = ++sequence
      if (!owner) { setData({ items: [] }); setLoading(false); return }
      setLoading(true)
      try {
        const items = await listProfitLockTemplates()
        if (active && current === sequence) { setData({ owner, items }); setError("") }
      } catch (e) {
        if (active && current === sequence) setError(e instanceof Error ? e.message : "模板加载失败")
      } finally { if (active && current === sequence) setLoading(false) }
    }
    void load()
    const reload = () => { void load() }
    window.addEventListener(changedEvent, reload)
    return () => { active = false; window.removeEventListener(changedEvent, reload) }
  }, [owner])
  const items = data.owner === owner ? data.items : []
  const template = [...BUILTIN_PROFIT_LOCK_TEMPLATES, ...items].find(t => t.id === chosen)
  const custom = items.find(t => t.id === chosen)
  async function mutate(action: "new" | "update" | "delete") {
    if (!owner || busy) return
    setBusy(true); setError(""); setNotice("")
    const sameSession = () => mounted.current && useAuthStore.getState().user?.id === owner
    try {
      if (action === "delete") {
        if (!custom) return
        await deleteProfitLockTemplate(custom.id)
        if (!sameSession()) return
        setChosen(""); setName(""); setNotice("模板已删除；当前任务参数保留")
      } else {
        const body = profitLockTemplateBody(name, value)
        const saved = await saveProfitLockTemplate(body, action === "update" ? custom?.id : undefined)
        if (!sameSession()) return
        setData(previous => ({ owner, items: [...previous.items.filter(t => t.id !== saved.id), saved] }))
        setChosen(saved.id); setName(saved.name); setNotice(action === "new" ? "模板已保存到服务器" : "模板已更新；已有任务不受影响")
      }
      window.dispatchEvent(new Event(changedEvent))
    } catch (e) { if (sameSession()) setError(e instanceof Error ? e.message : "模板操作失败") }
    finally { if (sameSession()) setBusy(false) }
  }
  return <div className="space-y-2 border-b border-[var(--border)] pb-3">
    <Label htmlFor={id + "-template"}>锁利模板</Label>
    <select id={id + "-template"} disabled={busy} className="w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs" value={template?.id ?? ""} onChange={e => {
      const selected = [...BUILTIN_PROFIT_LOCK_TEMPLATES, ...items].find(t => t.id === e.target.value)
      setChosen(selected?.id ?? ""); setName(selected?.name ?? ""); setError(""); setNotice("")
      if (selected) onChange(applyProfitLockTemplate(selected, value.enabled))
    }}>
      <option value="">自定义 · 当前任务参数</option>
      <optgroup label="内置模板">{BUILTIN_PROFIT_LOCK_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
      {items.length > 0 && <optgroup label="我的模板">{items.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
    </select>
    {loading && <p className="text-xs text-[var(--text-muted)]">正在加载我的模板…</p>}
    {template && !matchesProfitLockTemplate(value, template) && <p className="text-xs text-amber-500">当前参数已调整，可更新原模板或另存为新模板。</p>}
    <Label htmlFor={id + "-template-name"}>模板名称</Label>
    <Input id={id + "-template-name"} maxLength={80} placeholder="例如：短线锁利、长线锁利" value={name} disabled={busy} onChange={e => setName(e.target.value)} />
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={!owner || busy} onClick={() => void mutate("new")}>另存为新模板</Button>
      {custom && <><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void mutate("update")}>更新此模板</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void mutate("delete")}>删除此模板</Button></>}
    </div>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-500">{notice}</p>}
    <p className="text-xs text-[var(--text-muted)]">{owner ? "模板按账号保存，可在不同任务中复用。" : "登录后可以保存自己的模板。"}创建任务会复制当前参数，更新或删除模板不改变已有任务。</p>
  </div>
}
