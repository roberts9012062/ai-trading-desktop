import { useEffect, useRef, useState } from "react"
import { Download, Upload, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useAuthStore } from "@/stores/auth"
import { showAlert } from "@/stores/dialog"
import { strategyTransfer, parseStrategyFile, missingTransferModels, TransferError, type TransferKind, type StrategyFile, type TransferPreview } from "@/lib/strategy-transfer"

export function StrategyExportButton({ taskId, kind = "all", favoriteId, label = "导出", disabled = false }: { taskId?: string; kind?: TransferKind | "all"; favoriteId?: string; label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  return <Button type="button" size="sm" variant="outline" disabled={busy || disabled} title={taskId ? "导出完整任务配置" : "导出收藏配置"}
    onClick={async event => {
      event.stopPropagation(); setBusy(true)
      try {
        const result = taskId ? await strategyTransfer.exportTask(taskId) : await strategyTransfer.exportFavorites(kind, favoriteId)
        if (result.status === "saved") await showAlert({ title: "导出成功", description: `配置已保存至：${result.path}` })
      }
      catch (e) { await showAlert({ title: "导出失败", description: e instanceof Error ? e.message : "请稍后重试" }) }
      finally { setBusy(false) }
    }}>{busy ? <Loader2 size={13} className="animate-spin"/> : <Download size={13}/>}<span>{label}</span></Button>
}

export function StrategyImportDialog({ open, mode, onClose, onImported }: { open: boolean; mode: "tasks" | "favorites"; onClose: () => void; onImported?: () => void }) {
  const account = useAuthStore(s => s.user ? `${s.user.id}:${s.user.trading_mode}` : "")
  const [file, setFile] = useState<StrategyFile | null>(null)
  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [filename, setFilename] = useState("")
  const [models, setModels] = useState<Record<string, string>>({})
  const [run, setRun] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [serverConflicts, setServerConflicts] = useState<string[]>([])
  const generation = useRef(0)
  useEffect(() => { generation.current++; setFile(null); setPreview(null); setModels({}); setRun(false); setError(null); setDone(null); setFilename(""); setServerConflicts([]); setBusy(false) }, [open, account])
  const collisions = [...new Set([...(preview?.items.filter(i => i.conflict).map(i => i.symbol ?? "") ?? []), ...serverConflicts])]
  const tasks = preview?.items.filter(i => i.kind === "task") ?? []
  const importTasks = mode === "tasks" && tasks.length > 0
  async function read(selected?: File) {
    if (!selected) return
    const current = ++generation.current
    setBusy(true); setError(null); setDone(null); setFile(null); setPreview(null); setRun(false); setServerConflicts([])
    try {
      if (selected.size > 10*1024*1024) throw new Error("文件超过 10 MB，请分批导入")
      const data = parseStrategyFile(await selected.text())
      const result = await strategyTransfer.preview(data)
      if (current !== generation.current) return
      setFilename(selected.name); setFile(data); setPreview(result)
      setModels(Object.fromEntries(result.items.filter(i => i.model_row_id).map(i => [String(i.index), i.model_row_id!])))
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : "文件读取失败") }
    finally { if (current === generation.current) setBusy(false) }
  }
  async function submit(destination: "tasks" | "favorites") {
    if (!file || !preview || busy) return
    if (destination === "tasks" && (collisions.length || missingTransferModels(file, preview, models))) return
    const current = generation.current
    setBusy(true); setError(null)
    try {
      const result = await strategyTransfer.import(file, destination, destination === "tasks" && run, models)
      if (current !== generation.current) return
      const created = result.items.filter(i => i.created).length
      setDone(`${created ? `已创建 ${created} 个任务${run ? "，按当前账户交易环境运行" : "，未启动，等待手动运行"}。` : ""}已导入 ${result.imported} 项${destination === "favorites" ? "到对应收藏夹" : "配置"}，跳过 ${result.duplicates} 项重复收藏。`)
      window.dispatchEvent(new Event("strategy-favorites-changed")); onImported?.()
    } catch (e) {
      if (current === generation.current) {
        if (e instanceof TransferError) setServerConflicts(e.symbols)
        setError(e instanceof Error ? e.message : "导入失败")
      }
    } finally { if (current === generation.current) setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose() }}>
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{mode === "tasks" ? "任务导入" : "导入到策略收藏夹"}</DialogTitle><DialogDescription>选择导出的 JSON 文件，预览后确认。AI 任务、因子和短线因子会自动归类；配置不包含账户密钥、持仓或成交记录。</DialogDescription></DialogHeader>
      <label className="space-y-2 block text-sm">配置文件<input aria-label="选择配置文件" type="file" accept=".json,application/json" disabled={busy} className="block w-full rounded-md border border-[var(--border)] p-2 text-xs" onChange={e => { const selected = e.target.files?.[0]; e.target.value=""; void read(selected) }}/></label>
      {busy && !preview && <p role="status" className="text-xs">正在校验文件…</p>}
      {preview && file && <>
        <p className="text-xs text-[var(--text-muted)]">{filename} · {preview.items.length} 项配置 · {tasks.length} 个任务</p>
        {preview.items.map(item => <section key={item.index} className="rounded-md border border-[var(--border)] p-3 space-y-2 text-xs">
          <div className="flex justify-between gap-2"><strong>{item.name || "未命名配置"}</strong><span>{item.symbol?.toUpperCase() || "通用"} · {item.timeframe || "—"}</span></div>
          <p className="text-[var(--text-muted)]">{item.kind === "task" ? "AI 任务收藏夹" : item.kind === "factor" ? "因子收藏夹" : "短线因子收藏夹"} · {item.folder}</p>
          {item.requires_model && <label className="block space-y-1">本账号执行模型<select aria-label={`${item.name || "任务"}的执行模型`} className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2" value={models[String(item.index)] || ""} disabled={busy || Boolean(done)} onChange={e => setModels(s => ({...s,[String(item.index)]:e.target.value}))}>
            <option value="">请选择（可先保存收藏）</option>{preview.models.filter(m => (m.api_type === "jev") === (file.items[item.index].config.strategy_type === "decision")).map(m => <option key={m.id} value={m.id}>{m.display_name} · {m.model_id}</option>)}
          </select></label>}
          <details><summary className="cursor-pointer text-[var(--text-secondary)]">查看完整配置</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(file.items[item.index].config,null,2)}</pre></details>
        </section>)}
        {importTasks && !done && <fieldset className="rounded-md border border-[var(--border)] p-3 text-xs space-y-2"><legend className="px-1">导入后是否运行任务</legend>
          <label className="flex gap-2"><input type="radio" name="import-run" checked={!run} disabled={busy} onChange={()=>setRun(false)}/>仅创建，稍后手动运行（默认）</label>
          <label className="flex gap-2"><input type="radio" name="import-run" checked={run} disabled={busy} onChange={()=>setRun(true)}/>导入后立即运行 {tasks.length} 个任务，使用当前账号的交易环境</label>
        </fieldset>}
        {mode === "tasks" && preview.items.some(i=>i.kind!=="task") && <p className="text-xs text-[var(--text-muted)]">文件中的因子和短线因子会保存到各自收藏夹，不会创建交易任务。</p>}
        {importTasks && collisions.length>0 && !done && <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400">无法创建任务：{collisions.map(s=>s.toUpperCase()).join("、")} 已存在相同币种任务或文件内重复。请使用“导入到收藏夹”保存配置。</p>}
      </>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {done && <p role="status" className="rounded-md border border-emerald-500/30 p-3 text-xs text-emerald-400">{done}</p>}
      <div className="flex justify-end gap-2 flex-wrap"><Button variant="outline" disabled={busy} onClick={onClose}>{done ? "完成" : "取消"}</Button>
        {file && preview && !done && <>
          <Button disabled={busy} variant={importTasks && !collisions.length ? "outline" : "default"} onClick={()=>void submit("favorites")}>{busy ? "导入中…" : "导入到收藏夹"}</Button>
          {importTasks && <Button disabled={busy || collisions.length>0 || missingTransferModels(file,preview,models)} title={collisions.length ? "相同币种已存在，无法创建任务" : undefined} onClick={()=>void submit("tasks")}>{busy ? "导入中…" : run ? "确认导入并运行" : "确认导入，不运行"}</Button>}
        </>}
      </div>
    </DialogContent>
  </Dialog>
}

export function FavoriteTransferToolbar({ kind, onImported }: { kind: TransferKind | "all"; onImported?: () => void }) {
  const [open,setOpen]=useState(false)
  return <div className="flex items-center gap-2 flex-wrap"><Button size="sm" variant="outline" onClick={()=>setOpen(true)}><Upload size={13}/>导入配置</Button><StrategyExportButton kind={kind} label={kind==="all" ? "导出全部收藏" : "导出本类收藏"}/><StrategyImportDialog open={open} mode="favorites" onClose={()=>setOpen(false)} onImported={onImported}/></div>
}
