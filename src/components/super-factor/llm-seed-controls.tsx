"use client"

import {useEffect, useRef, useState} from "react"
import {getAIModels} from "@/lib/api"
import {chatModelsOnly} from "@/lib/decision-model"
import {Button} from "@/components/ui/button"
import {Label} from "@/components/ui/label"

interface ModelOption {id: string; label: string}
interface Props {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  model: string
  onModelChange: (id: string) => void
  hint: string
  onHintChange: (hint: string) => void
  error: string | null
}

/** Seed generation uses the same user-owned models as AI settings. */
export function LlmSeedControls(props: Props) {
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const current = useRef(props)
  current.current = props
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false
    let revision = 0
    async function refresh() {
      const request = ++revision
      setLoading(true)
      setLoadError(null)
      let options: ModelOption[] = []
      try {
        const list = await getAIModels()
        options = chatModelsOnly(list).map(m => ({id:m.id,label:`${m.provider_name} · ${m.display_name || m.model_id}`}))
      } catch (e) {
        if (!disposed && request === revision) setLoadError(`读取 AI 设置失败：${e instanceof Error ? e.message : String(e)}`)
      }
      if (disposed || request !== revision) return
      setModels(options)
      setLoading(false)
      const selected = options.some(m => m.id === current.current.model)
        ? current.current.model : options[0]?.id || ""
      current.current.onModelChange(selected)
      if (!selected) current.current.onEnabledChange(false)
    }
    refreshRef.current = () => { void refresh() }
    refreshRef.current()
    window.addEventListener("focus", refreshRef.current)
    window.addEventListener("storage", refreshRef.current)
    return () => {
      disposed = true
      window.removeEventListener("focus", refreshRef.current)
      window.removeEventListener("storage", refreshRef.current)
    }
  }, [])
  const ready = !loading && models.some(m => m.id === props.model)
  return <div className="space-y-2">
    <Label>LLM 种子（可选）</Label>
    <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
      <input type="checkbox" checked={props.enabled} disabled={!ready}
        onChange={e => props.onEnabledChange(e.target.checked)} />
      用大模型生成候选公式，注入种群当种子
    </label>
    <div className="flex items-center gap-2">
      <label htmlFor="llm-seed-model" className="text-[11px] shrink-0">种子模型</label>
      <select id="llm-seed-model" value={props.model} disabled={loading || models.length === 0}
        onChange={e => props.onModelChange(e.target.value)}
        className="min-w-0 flex-1 h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-xs">
        {models.length === 0 && <option value="">{loading ? "正在读取 AI 设置…" : "暂无可用对话模型"}</option>}
        {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => refreshRef.current()}>刷新模型</Button>
    </div>
    {loadError && <p role="alert" className="text-[10px] text-down">{loadError}</p>}
    {!loading && !models.length && !loadError && <p className="text-[10px] text-amber-500">
      请先在「AI 设置」中添加对话模型；决策模型不能生成因子公式。添加后点击「刷新模型」。
    </p>}
    <p className="text-[10px] text-[var(--text-muted)]">使用「AI 设置」中已添加的对话模型，无需重复配置。</p>
    {props.enabled && <input type="text" value={props.hint} onChange={e => props.onHintChange(e.target.value)}
      aria-label="种子挖掘思路" placeholder="挖掘思路提示（可选），如「关注量价背离」"
      className="w-full h-9 px-3 text-xs rounded-md border border-[var(--border)] bg-[var(--bg-primary)]" />}
    {props.error && <p role="alert" className="text-[10px] text-down">{props.error}</p>}
    <p className="text-[10px] text-[var(--text-muted)] leading-tight">
      提交时由所选模型生成 6–10 条候选公式，经当前数据词表和 token 校验后进入进化；
      候选仍须通过挖掘验证。使用 AI 设置中的模型会计入因子实验室每日次数及模型服务商用量。
    </p>
  </div>
}
