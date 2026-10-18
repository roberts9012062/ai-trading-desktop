import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Link, useLocation } from "react-router-dom"
import { ArrowRight, Dna, FlaskConical, Pause, Play, RefreshCw, Save, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getAIModels } from "@/lib/api"
import { chatModelsOnly } from "@/lib/decision-model"
import type { AIModel } from "@/types"
import { prepareSearchBars } from "@/lib/local-factor"
import { readCachedOkxFunding } from "@/lib/okx-history"
import { fetchFundingHistory } from "@/lib/binance-futures"
import { barTimeToMs } from "@/lib/binance-kline"
import { attachEvolutionFunding } from "@/lib/factor-evolution-funding"
import { enrichBarsWithOrderflow } from "@/lib/shortline/task-enrich"
import { TIMEFRAME_SECONDS, type ShortlineTimeframe } from "@/lib/shortline/spec"
import { DataChannelSelect } from "@/components/common/data-channel-select"
import { researchFactorRangeFor } from "../factor-range-limits"
import { readFactorValidation, writeFactorValidation } from "@/lib/factor-validation-settings"
import { completeFundingMonthEnd, evolutionFundingIssue, evolutionHistoryGap, evolutionSamplePlan } from "@/lib/factor-evolution-samples"
import { applyEvolutionJob, cancelEvolutionReplacement, createEvolutionJob, getEvolutionJob, getEvolutionTargets, getEvolutionTaskState,canReplaceTaskEvolution,
  type EvolutionJob, type EvolutionMetrics, type EvolutionSource } from "@/lib/factor-evolution-api"
import { evolutionRunning, evolutionSnapshot, restoreEvolution, runEvolution, showEvolutionJob, stopEvolution, subscribeEvolution } from "@/lib/factor-evolution-runner"
import { EvolutionProgressPanel } from "./evolution-progress"
import { EvolutionResearchReport, FormulaEvidencePanel } from "./evolution-research-report"
import { downloadAuthenticatedFile } from "@/lib/download"
import { TaskFactorReviewPanel } from './task-factor-review'

const box = "rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
const selectStyle = "w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-xs px-2"
const statuses: Record<EvolutionJob["status"], string> = {context: "复盘任务历史", ready: "等待下一轮", paused: "已暂停", stopped: "已停止", passed: "封存验收通过", exhausted: "已达到迭代上限", sealed_failed: "封存验收未通过"}
const kindLabels = {favorite: "因子收藏", shortline_favorite: "短线收藏", task: "运行任务", candidate: "挖掘候选", favorites: "组合收藏"}
const pct = (n?: number) => n == null ? "—" : `${(n * 100).toFixed(2)}%`

function MetricRow({label, metrics}: {label: string; metrics?: EvolutionMetrics}) {
  return <tr className="border-t border-[var(--border)]"><td className="py-2 pr-3">{label}</td><td>{metrics?.bars ?? "—"}</td><td className={metrics && metrics.ann_ret > 0 ? "text-up" : "text-down"}>{pct(metrics?.ann_ret)}</td><td>{metrics?.sortino.toFixed(2) ?? "—"}</td><td>{pct(metrics?.stress_ann_ret)}</td><td>{metrics?.stress_sortino.toFixed(2) ?? "—"}</td><td>{metrics?.discrete_sortino?.toFixed(2) ?? "—"}</td></tr>
}

export function FactorEvolutionPage() {
  const location = useLocation()
  const selectedLocation = useRef("")
  const state = useSyncExternalStore(subscribeEvolution, evolutionSnapshot)
  const {job, running} = state
  const [targets, setTargets] = useState<EvolutionSource[]>([])
  const [models, setModels] = useState<AIModel[]>([])
  const [source, setSource] = useState<EvolutionSource | null>(null)
  const [model, setModel] = useState("")
  const [symbol, setSymbol] = useState("BTCUSDT")
  const [timeframe, setTimeframe] = useState("1d")
  const [channel, setChannel] = useState("okx")
  const [start, setStart] = useState(() => researchFactorRangeFor("1d").start)
  const [end, setEnd] = useState(() => researchFactorRangeFor("1d").end)
  const [validation, setValidation] = useState(readFactorValidation)
  const [rounds, setRounds] = useState("20")
  const [fee, setFee] = useState("0.05")
  const [slippage, setSlippage] = useState("2")
  const [hint, setHint] = useState("")
  const [alias, setAlias] = useState("")
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [application, setApplication] = useState<{id: string; status: string} | null>(null)
  const [folder, setFolder] = useState("")
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [history, setHistory] = useState<{n: number; first: string; last: string} | null>(null)
  const [historyFix, setHistoryFix] = useState<{start?: string; end?: string} | null>(null)
  const favoriteTargets = targets.filter(t => ["favorite", "shortline_favorite"].includes(t.kind))
  const visibleTargets = targets.filter(t => t.kind === "task" || !folder || (t.folder_name || "未分组") === folder)
  const last = job?.reports.at(-1)
  const disabled = busy || running
  const samplePlan = evolutionSamplePlan(history?.n || 0, timeframe, validation)
  const monthlyFunding = channel === "okx" || channel === "binance_usdt"
  const fundingMonthEnd = completeFundingMonthEnd()

  async function refreshTargets() {
    try { setTargets(await getEvolutionTargets()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => {
    void refreshTargets()
    void restoreEvolution()
    void getAIModels().then(list => { const chats = chatModelsOnly(list); setModels(chats); setModel(prev => prev || chats[0]?.id || "") }).catch(e => setError(String(e)))
  }, [])
  useEffect(() => {
    const incoming = (location.state as {evolutionTarget?: EvolutionSource} | null)?.evolutionTarget
    if (!incoming || selectedLocation.current === location.key) return
    const resolved = incoming.id ? targets.find(t => t.id === incoming.id && t.kind === incoming.kind) : incoming
    if (resolved) {choose(resolved); selectedLocation.current = location.key}
  }, [location.key, targets])
  useEffect(() => { writeFactorValidation(validation) }, [validation])
  useEffect(() => {setHistory(null); setHistoryFix(null)}, [symbol, timeframe, channel, start, end])
  useEffect(() => {
    setApplication(job?.application || null)
    if (job && !alias) setAlias(`${job.source.name || "因子"}·进化`)
  }, [job?.id])
  useEffect(() => {
    if (application?.status !== "waiting_flat" || !job) return
    let active = true
    const poll = async () => {
      try {
        const current = await getEvolutionTaskState(application.id)
        if (!active) return
        if (current.applied_job_id === job.id) {setApplication({id: application.id, status: "applied"}); setMessage("进化因子已在平仓确认后生效，任务已切换为新配方")}
        else if (current.pending_job_id !== job.id) {setApplication(null); setMessage("该进化替换已不在待生效队列，请查看任务运行日志")}
      } catch { /* manual refresh can show an actionable network error */ }
    }
    void poll()
    const timer = setInterval(() => void poll(), 15000)
    return () => {active = false; clearInterval(timer)}
  }, [application?.id, application?.status, job?.id])

  function choose(next: EvolutionSource) {
    if (next.unavailable) {setError(next.unavailable); setSource(null); return}
    setSource(next)
    const tf = ({"1h": "60m", "4h": "240m"} as Record<string, string>)[next.timeframe || ""] || next.timeframe || "1d"
    const ch = next.data_channel || "okx"
    const range = researchFactorRangeFor(tf, ch)
    setSymbol(next.symbol || "BTCUSDT"); setTimeframe(tf); setChannel(ch)
    const taskEnd = next.kind === "task" && next.task_created_at ? new Date(Date.parse(next.task_created_at) - 86400000).toISOString().slice(0, 10) : range.end
    setStart(next.start_date || range.start); setEnd(next.end_date || (taskEnd < range.end ? taskEnd : range.end))
    setAlias(`${next.name || "因子"}·进化`); setError(null); setMessage(null)
  }
  function combineFavorites(ids: string[]) {
    setSelectedIds(ids)
    const chosen = targets.filter(t => ids.includes(`${t.kind}:${t.id}`))
    if (!chosen.length) {setSource(null); return}
    if (chosen.length === 1) {choose(chosen[0]); return}
    if (new Set(chosen.map(t => `${t.symbol}:${t.timeframe}:${!!t.shortline}`)).size > 1) {setError("请组合相同品种、周期和研究类型的收藏"); setSource(null); return}
    const groups = chosen.flatMap(t => t.recipe?.groups || [])
    if (groups.length > 5) {setError("组合进化最多 5 个公式成员"); setSource(null); return}
    choose({kind: "favorites", ids: chosen.map(t => ({kind: t.kind as "favorite" | "shortline_favorite", id: t.id!})),
      name: `组合进化 · ${chosen.map(t => t.name).join(" / ")}`, symbol: chosen[0].symbol, timeframe: chosen[0].timeframe,
      shortline: chosen[0].shortline, recipe: {groups, weights: chosen.flatMap(t => t.recipe!.weights.map(w => w / chosen.length))}})
  }
  async function startEvolution() {
    if (!source || !model) { setError("请选择进化目标和对话模型"); return }
    if (!validation.enabled || validation.train_ratio < .1 || validation.walk_forward_folds < 2) { setError("进化须启用防过拟合、训练比例 ≥0.1 和至少 2 折 Walk-Forward；可在下方修改共享设置"); return }
    if (samplePlan.fixedIssue) {setError(samplePlan.fixedIssue); return}
    const maxRounds = Number(rounds)
    if (!rounds.trim() || !Number.isInteger(maxRounds) || maxRounds < 0 || maxRounds > 10000) { setError("请输入 0–10000 的整数轮数，0 表示无限迭代"); return }
    if (!start || !end || start >= end) { setError("请填写有效历史起止日期"); return }
    const feeRate = Number(fee) / 100, slip = Number(slippage)
    if (!Number.isFinite(feeRate) || feeRate < .0001 || feeRate > .05 || !Number.isFinite(slip) || slip < 0 || slip > 100) { setError("手续费须在 0.01%–5%，滑点须在 0–100 bps"); return }
    setBusy(true); setStage("准备下载历史行情…"); setError(null); setMessage(null); setApplication(null); setHistory(null); setHistoryFix(null)
    try {
      let bars = await prepareSearchBars({symbol: symbol.trim().toUpperCase(), timeframe, data_channel: channel, start_date: start, end_date: end,
        population: 1, generations: 1, top_n: 1, seed: 0}, setStage)
      setHistory({n:bars.length, first:bars[0].time, last:bars.at(-1)!.time})
      const plan = evolutionSamplePlan(bars.length, timeframe, validation)
      if (bars.length > 120000) throw new Error(`进化行情上限 120000 根，实际 ${bars.length} 根；请缩小区间`)
      if (plan.issue) throw new Error(plan.issue)
      const gap = evolutionHistoryGap(bars,timeframe)
      if (gap) {
        const suggestedEnd = monthlyFunding && end > fundingMonthEnd ? fundingMonthEnd : end
        if (gap.suggestedStart < suggestedEnd) setHistoryFix({start:gap.suggestedStart,end:suggestedEnd})
        throw new Error(gap.message)
      }
      if (channel === "okx" || channel === "binance_usdt") {
        setStage("补齐区间内每一次真实资金费率结算…")
        const from = bars[0].open_time ?? barTimeToMs(bars[0].time)
        const to = bars.at(-1)!.open_time ?? barTimeToMs(bars.at(-1)!.time)
        const events = channel === "okx" ? await readCachedOkxFunding(symbol, from, to) : await fetchFundingHistory(symbol, from, to, setStage)
        const fundingIssue = evolutionFundingIssue(bars,events)
        if (fundingIssue) {
          const lastEvent = events.at(-1)
          const suggestedEnd = lastEvent ? new Date(lastEvent.t).toISOString().slice(0,10) : fundingMonthEnd
          if (start < suggestedEnd && suggestedEnd < end) setHistoryFix({end:suggestedEnd})
          throw new Error(fundingIssue)
        }
        bars = attachEvolutionFunding(bars, events)
      }
      if (source.shortline && (channel === "okx" || channel === "binance_usdt")) {
        const needsOrderflow = source.recipe?.groups.some(g => g.some(t => t >= 115))
        if (timeframe in TIMEFRAME_SECONDS) {
          setStage("注入已回填的逐笔订单流数据…")
          try {
            const result = await enrichBarsWithOrderflow(bars, symbol, timeframe as ShortlineTimeframe, channel)
            if (result.enrichedBars < bars.length && needsOrderflow) throw new Error(`订单流覆盖不足（${result.enrichedBars}/${bars.length} 根）；请先在短线实验室完成相同区间回填`)
          } catch (e) {
            if (needsOrderflow) throw e
            setStage("订单流归档不完整，本轮仅使用有完整数据的技术特征…")
          }
        } else if (needsOrderflow) throw new Error("当前周期不支持订单流回放，请选择短线实验室支持的周期")
      }
      setStage("冻结行情及防过拟合设置…")
      const created = await createEvolutionJob({source, model_row_id: model, symbol: symbol.trim().toUpperCase(), timeframe,
        data_channel: channel, bars, max_rounds: maxRounds, hint,
        settings: {train_ratio: validation.train_ratio, test_recent_bars: validation.test_recent_bars, walk_forward_folds: validation.walk_forward_folds,
          fee_rate: feeRate, slippage_bps: slip, execution_model: ["okx", "binance_usdt", "gate_usdt"].includes(channel) ? "perp_next_open" : "spot_long_flat"}})
      showEvolutionJob(created)
      void runEvolution(created)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); setStage("") }
  }
  async function apply(action: "save" | "replace_favorite" | "replace_task") {
    if (!job) return
    setBusy(true); setError(null)
    try {
      const result = await applyEvolutionJob(job.id, action, alias)
      setApplication(result)
      setMessage(result.status === "waiting_flat" ? "替换请求已保存。服务器确认本任务持仓、委托及保护单清理完成后自动切换；原任务继续运行。" : action === "save" ? `已另存为「${result.name}」` : "原收藏已替换，收藏位置及备注保留")
      window.dispatchEvent(new Event("strategy-favorites-changed")); void refreshTargets()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function refreshJob() {
    if (!job) return
    try {
      showEvolutionJob(await getEvolutionJob(job.id))
      if (job.source.kind === "task" && job.source.id) {
        const result = await getEvolutionTaskState(job.source.id)
        setApplication(result.pending_job_id === job.id ? {id: job.source.id, status: "waiting_flat"} : null)
        if (result.applied_job_id === job.id) setMessage("进化因子已在平仓确认后生效，任务正在使用新配方")
      }
    } catch (e) { setError(String(e)) }
  }

  return <div className="h-full overflow-auto p-4 lg:p-6 text-[var(--text-primary)] space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><Link to="/factor-lab" className="text-xs text-[var(--text-muted)]">因子实验室 /</Link><h1 className="text-xl font-semibold mt-1 flex items-center gap-2"><Dna size={23} className="text-[var(--primary)]" />因子进化</h1><p className="text-xs text-[var(--text-muted)] mt-2">让 AI 核查真实K线、运行记录与公式分支，修正后自动审查和回测，通过验收再由你点击替换。</p></div>
      <div className="flex gap-2 text-[11px] text-[var(--text-muted)] pt-2"><span>选择目标</span><ArrowRight size={13} /><span>LLM 迭代</span><ArrowRight size={13} /><span>样本外验收</span><ArrowRight size={13} /><span>保存或替换</span></div>
    </header>
    <EvolutionProgressPanel job={job} running={running} preparing={busy && !!stage} stage={stage || state.stage} progress={state.progress} stepStartedAt={running ? state.stepStartedAt : undefined} />
    {(error || state.error) && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-down">{error || state.error}</p>}
    {historyFix && <div className="flex flex-wrap items-center gap-2 text-xs"><span>建议区间：{historyFix.start || start} 至 {historyFix.end || end}（重新取数校验）</span><Button size="sm" variant="outline" disabled={disabled} onClick={() => {if (historyFix.start) setStart(historyFix.start); if (historyFix.end) setEnd(historyFix.end); setError(null)}}>使用建议历史区间</Button></div>}
    {message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-up">{message}</p>}
    <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-5 items-start">
      <section className={`${box} p-4 space-y-4`}>
        <div className="flex justify-between items-center"><h2 className="text-sm font-medium">1. 选择进化目标</h2><button type="button" onClick={() => void refreshTargets()} aria-label="刷新目标" className="text-[var(--text-muted)]"><RefreshCw size={14} /></button></div>
        {source?.kind === "candidate" && <div className="border border-[var(--primary)]/30 rounded-lg p-2 text-xs"><span className="text-[var(--primary)]">当前挖掘候选</span><p className="mt-1 break-all">{source.name || "选中的因子"} · {source.recipe?.groups.length} 个成员</p></div>}
        <label className="block text-xs space-y-1.5"><span>收藏文件夹</span><select aria-label="收藏文件夹" className={selectStyle} disabled={disabled} value={folder} onChange={e => setFolder(e.target.value)}><option value="">全部收藏夹</option>{[...new Set(favoriteTargets.map(t => t.folder_name || "未分组"))].map(name => <option key={name}>{name}</option>)}</select></label>
        <label className="block text-xs space-y-1.5"><span>收藏夹 / 在跑任务</span><select className={selectStyle} disabled={disabled} value={source?.id ? `${source.kind}:${source.id}` : ""} onChange={e => {const next = targets.find(t => `${t.kind}:${t.id}` === e.target.value); if (next) choose(next)}}><option value="">请选择目标…</option>{["favorite", "shortline_favorite", "task"].map(kind => <optgroup key={kind} label={kindLabels[kind as keyof typeof kindLabels]}>{visibleTargets.filter(t => t.kind === kind).map(t => <option key={t.id} value={`${t.kind}:${t.id}`} disabled={!!t.unavailable}>{t.name} {t.symbol ? `· ${t.symbol} · ${t.timeframe}` : ""}{t.unavailable ? `（${t.unavailable}）` : ""}</option>)}</optgroup>)}</select></label>
        {source?.recipe && <details className="text-[11px] text-[var(--text-muted)]"><summary className="cursor-pointer">原配方 · {source.recipe.groups.length} 成员</summary><pre className="mt-2 whitespace-pre-wrap break-all font-mono">{JSON.stringify(source.recipe, null, 2)}</pre></details>}
        {source?.kind === "task" && <p className="text-[11px] text-[var(--text-muted)]">完整任务日志作为优化输入；独立验收默认使用任务创建前的历史，避免日志中的盈亏泄漏到最终封存。</p>}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={multiSelect} disabled={disabled} onChange={e => {setMultiSelect(e.target.checked); setSelectedIds([])}} />组合多个收藏一起进化</label>
        {multiSelect && <div className="max-h-48 overflow-auto space-y-2 border border-[var(--border)] rounded-lg p-2">{visibleTargets.filter(t => ["favorite", "shortline_favorite"].includes(t.kind)).map(t => {const key = `${t.kind}:${t.id}`; return <label key={key} className="flex gap-2 items-start text-[11px]"><input type="checkbox" checked={selectedIds.includes(key)} disabled={disabled || !!t.unavailable} onChange={e => combineFavorites(e.target.checked ? [...selectedIds, key] : selectedIds.filter(id => id !== key))} /><span>{t.name} · {t.symbol} · {t.timeframe}{t.unavailable && `（${t.unavailable}）`}</span></label>})}<p className="text-[10px] text-[var(--text-muted)]">最多 5 个公式成员；组合进化可另存，单条收藏可原位替换。</p></div>}
        <label className="block text-xs space-y-1.5"><span>用户对话模型</span><select className={selectStyle} disabled={disabled} value={model} onChange={e => setModel(e.target.value)}><option value="">请选择模型…</option>{models.map(m => <option key={m.id} value={m.id}>{m.display_name || m.model_id} · {m.provider_name}</option>)}</select>{models.length === 0 && <Link to="/ai-settings" className="text-[var(--primary)]">前往 AI 设置添加模型</Link>}</label>
        <div className="grid grid-cols-2 gap-2"><label className="text-xs space-y-1.5">品种<Input aria-label="品种" value={symbol} disabled={disabled || !!source?.symbol} onChange={e => setSymbol(e.target.value)} /></label><label className="text-xs space-y-1.5">周期<select aria-label="周期" className={selectStyle} value={timeframe} disabled={disabled || !!source?.timeframe} onChange={e => {setTimeframe(e.target.value); const r = researchFactorRangeFor(e.target.value, channel); setStart(r.start); setEnd(r.end)}}>{["1m", "5m", "15m", "30m", "60m", "240m", "1d"].map(tf => <option key={tf}>{tf}</option>)}</select></label></div>
        <label className="block text-xs space-y-1.5"><span>历史数据渠道</span><DataChannelSelect value={channel} disabled={disabled} onChange={ch => {setChannel(ch); const range = researchFactorRangeFor(timeframe, ch); setStart(range.start); setEnd(range.end)}} /></label>
        <div className="grid grid-cols-2 gap-2"><label className="text-xs space-y-1.5">开始日期<Input aria-label="开始日期" type="date" value={start} disabled={disabled} onChange={e => setStart(e.target.value)} /></label><label className="text-xs space-y-1.5">结束日期<Input aria-label="结束日期" type="date" value={end} disabled={disabled} onChange={e => setEnd(e.target.value)} /></label></div>
        {monthlyFunding && end > fundingMonthEnd && <div className="text-[11px] text-[var(--text-muted)] space-y-2"><p>永续资金费率使用月归档，当月通常尚未发布。可先使用上一完整月份；仍以实际下载覆盖为准。</p><Button size="sm" variant="outline" disabled={disabled || start >= fundingMonthEnd} onClick={() => setEnd(fundingMonthEnd)}>结束日期改至 {fundingMonthEnd}</Button></div>}
        {history && <p role="status" className="text-[11px] text-[var(--text-muted)]">实际取数 {history.n.toLocaleString()} 根：{history.first} 至 {history.last}。训练预热后 {Math.max(0,samplePlan.train-samplePlan.warmup).toLocaleString()} / 验证 {samplePlan.validation.toLocaleString()} / 封存 {samplePlan.holdout.toLocaleString()} 根。</p>}
        <div className="grid grid-cols-2 gap-2"><label className="text-xs space-y-1.5">手续费（%）<Input aria-label="手续费" type="number" step="0.01" value={fee} disabled={disabled} onChange={e => setFee(e.target.value)} /></label><label className="text-xs space-y-1.5">滑点（bps）<Input aria-label="滑点" type="number" value={slippage} disabled={disabled} onChange={e => setSlippage(e.target.value)} /></label></div>
        <label className="block text-xs space-y-1.5"><span>优化要求（可选）</span><textarea className={`${selectStyle} h-20 py-2 resize-y`} disabled={disabled} maxLength={3000} value={hint} onChange={e => setHint(e.target.value)} placeholder="例如：减少反复开平仓，保留趋势逻辑" /></label>
        <label className="block text-xs space-y-1.5"><span>最大迭代轮数</span><Input aria-label="最大迭代轮数" type="number" min={0} max={10000} value={rounds} disabled={disabled} onChange={e => setRounds(e.target.value)} /><span className="block text-[10px] text-[var(--text-muted)]">默认 20；0 持续迭代直至通过，可随时停止。模型调用按用户渠道计费。</span></label>
        <Button className="w-full" disabled={disabled || !source || !model} onClick={() => void startEvolution()}><Play size={14} />{busy ? stage || "处理中…" : "开始进化"}</Button>
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">页面切换可继续推进；关闭应用会暂停。作业和行情快照保留 7 天，重新打开后可手动恢复。</p>
      </section>
      <div className="space-y-4 min-w-0">
        {source?.kind==='task'&&source.id&&!source.shortline&&<TaskFactorReviewPanel key={source.id} taskId={source.id} disabled={disabled}/>}
        <section className={`${box} p-4 space-y-3`}>
          <h2 className="text-sm font-medium flex items-center gap-2"><ShieldCheck size={16} className="text-[var(--primary)]" />2. 防过拟合设置 <span className="text-[10px] text-[var(--text-muted)] font-normal">与因子实验室共享</span></h2>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={disabled} checked={validation.enabled} onChange={e => setValidation(v => ({...v, enabled: e.target.checked}))} />启用训练/测试切分 + Walk-Forward 样本外验证（进化必需）</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><label className="text-xs space-y-1.5">训练比例<Input aria-label="训练比例" type="number" min={0} max={.9} step={.05} disabled={disabled} value={validation.train_ratio} onChange={e => setValidation(v => ({...v, train_ratio: Number(e.target.value)}))} /></label><label className="text-xs space-y-1.5">近期作测试（0=按比例）<Input aria-label="近期作测试" type="number" min={0} max={20000} disabled={disabled} value={validation.test_recent_bars} onChange={e => setValidation(v => ({...v, test_recent_bars: Number(e.target.value)}))} /></label><label className="text-xs space-y-1.5">Walk-Forward 折数<Input aria-label="Walk-Forward 折数" type="number" min={0} max={10} disabled={disabled} value={validation.walk_forward_folds} onChange={e => setValidation(v => ({...v, walk_forward_folds: Number(e.target.value)}))} /></label></div>
          <p className="text-[11px] text-[var(--text-muted)]">当前 {timeframe}：验证至少 {samplePlan.minValidation.toLocaleString()} 根，封存至少 {samplePlan.minHoldout.toLocaleString()} 根；两段分别覆盖至少 {samplePlan.days} 天。</p>
          {samplePlan.fixedIssue && <div className="text-xs text-down space-y-2"><p>{samplePlan.fixedIssue}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => {setValidation(v => ({...v,test_recent_bars:0})); setError(null)}}>改为按比例切分</Button></div>}
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">最后 20% 单独封存，训练比例作用于其余 80%。每轮只反馈训练和验证；达到门槛后封存验收一次，失败即结束。次根开盘成交，同时检查阈值开平仓收益及双倍成本压力（无杠杆，不含原任务全部止盈止损或短线逐笔成交细节）；永续还要求完整资金费率事件。验证、封存各覆盖至少 30 天，分钟短线周期至少 7 天。</p>
        </section>
        {!job ? <section className={`${box} py-16 text-center space-y-3`}><FlaskConical size={30} className="mx-auto text-[var(--text-muted)]" /><p className="text-sm">选择一个值得继续打磨的因子</p><p className="text-xs text-[var(--text-muted)]">每轮保留公式变更、验证结果和失败原因。</p></section> : <>
          <section className={`${box} p-4 space-y-3`}>
            <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-medium">3. {running ? "进化进行中" : statuses[job.status]}</h2><p className="text-xs text-[var(--text-muted)] mt-1">{job.source.name || "挖掘候选"} · {job.symbol} · {job.timeframe} · 第 {job.round}/{job.max_rounds || "∞"} 轮</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void refreshJob()}><RefreshCw size={13} />刷新</Button>{running ? <Button size="sm" variant="outline" onClick={() => void stopEvolution().catch(e => setError(String(e)))}><Pause size={13} />停止</Button> : !job.sealed_used && !["passed", "exhausted"].includes(job.status) && <Button size="sm" disabled={busy} onClick={() => void runEvolution(job, !evolutionRunning(job))}><Play size={13} />恢复进化</Button>}</div></div>
            {(state.stage || stage) && <p role="status" className="text-xs text-[var(--primary)]">{stage || state.stage}</p>}
            {job.error && <p role="alert" className="text-xs text-down">{job.error}</p>}
            {job.source.kind === "task" && <div className="text-[11px] text-[var(--text-muted)] space-y-1"><p>AI 历史覆盖：{Object.entries(job.coverage).map(([kind, c]) => `${({trades: "交易", run_logs: "运行日志", decisions: "决策", shortline_decisions: "短线决策"} as Record<string, string>)[kind] || kind} ${c.read}/${c.total}`).join(" · ")}</p><p>截止 {new Date(job.cutoff).toLocaleString()}。{job.history_note}</p></div>}
            <p className="text-[10px] text-[var(--text-muted)] break-all">行情指纹 {job.bars_sha256.slice(0, 20)}… · 冻结训练比例 {job.settings.train_ratio} / WF {job.settings.walk_forward_folds} 折 / 手续费 {pct(job.settings.fee_rate)} / 滑点 {job.settings.slippage_bps} bps · 结果不保证未来盈利</p>
            {job.status === "sealed_failed" && <p className="text-xs text-down">最终封存未通过；本次结束，不将封存结果交给模型反复调参。下一次研究应使用新的独立数据。</p>}
            {job.status === "passed" && (!last?.audit?.passed || !canReplaceTaskEvolution(job)) && <p className="text-xs text-amber-500">这是旧版验收结果，缺少本版自动审查或任务规则预筛；请新建研究后再替换任务。</p>}
            {job.status === "exhausted" && <p className="text-xs text-[var(--text-muted)]">已完成设定轮数，尚无通过全部验收的结果，原收藏和任务未修改。</p>}
          </section>
          <FormulaEvidencePanel title="原配方取证" evidence={job.research_evidence}/>
          {job.runtime_evidence&&<section className={`${box} p-4 space-y-2 text-xs`}><h2 className="font-medium">运行记录与K线复现</h2>{job.runtime_evidence.available?job.runtime_evidence.examples?.map(example=><div key={example.record.id}><p>{example.record.time} · 原记录窗口 {example.bars_used} 根{example.matches_current_recipe === false && " · 历史配方，与当前不同"}</p><p className="text-[var(--text-muted)]">{example.record.reason}</p><FormulaEvidencePanel title="该次信号实际窗口复算" evidence={{points:[example.point]}}/></div>):<p className="text-[var(--text-muted)]">{job.runtime_evidence.reason||"运行取证未完成"}</p>}<p className="text-[10px] text-[var(--text-muted)]">{job.runtime_evidence.note}</p></section>}
          {last&&<section className={`${box} p-4 space-y-3`}><div className="flex justify-between items-center gap-2"><h2 className="text-sm font-medium">研究报告与自动审查</h2><Button size="sm" variant="outline" onClick={() => void downloadAuthenticatedFile(`/api/factor-lab/evolution/jobs/${job.id}/report`,`factor-evolution-${job.id}.md`).catch(e=>setError(String(e)))}>导出研究报告</Button></div><EvolutionResearchReport report={last}/></section>}
          {last && <section className={`${box} p-4 space-y-3`}><div className="flex justify-between gap-3"><h2 className="text-sm font-medium">最新候选 · {last.recipe?.groups.length ?? 0} 成员</h2><span className={`text-xs ${job.status === "passed" && last.audit?.passed ? "text-up" : "text-[var(--text-muted)]"}`}>{job.status === "passed" && last.audit?.passed ? "✓ 研究验收通过" : "尚未通过全部验收"}</span></div><p className="font-mono text-xs break-all text-[var(--primary)]">{last.text || "模型未返回有效配方"}</p><p className="text-xs leading-relaxed text-[var(--text-secondary)]">{last.recipe?.rationale}</p>{last.error && <p className="text-xs text-down">{last.error}</p>}<div className="overflow-x-auto"><table className="w-full text-xs text-left whitespace-nowrap"><thead className="text-[var(--text-muted)]"><tr><th className="pr-3 pb-2">区间</th><th>根数</th><th>扣费年化</th><th>Sortino</th><th>2×成本年化</th><th>2× Sortino</th><th>离散 Sortino</th></tr></thead><tbody><MetricRow label="原配方验证" metrics={job.baseline?.validation} /><MetricRow label="训练" metrics={last.validation?.train} /><MetricRow label="验证" metrics={last.validation?.validation} />{last.validation?.folds?.map((m, i) => <MetricRow key={i} label={`WF ${i + 1}`} metrics={m} />)}<MetricRow label={last.sealed ? "最终封存" : "最终封存（未启封）"} metrics={last.sealed?.holdout} /></tbody></table></div>{last.validation?.reasons?.map(reason => <p key={reason} className="text-[11px] text-down">{reason}</p>)}</section>}
          {job.status === "passed" && last?.audit?.passed && <section className={`${box} p-4 space-y-3 border-emerald-500/30`}><h2 className="text-sm font-medium">4. 保存或应用进化结果</h2><label className="block text-xs space-y-1.5"><span>收藏别名</span><Input aria-label="收藏别名" value={alias} maxLength={80} onChange={e => setAlias(e.target.value)} placeholder={`${job.source.name || "因子"}·进化`} /></label><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void apply("save")}><Save size={14} />另存到收藏夹</Button>{["favorite", "shortline_favorite"].includes(job.source.kind) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void apply("replace_favorite")}>替换原收藏</Button>}{job.source.kind === "task" && <Button size="sm" variant="outline" disabled={busy || !canReplaceTaskEvolution(job) || application?.status === "waiting_flat"} onClick={() => void apply("replace_task")}>平仓后替换任务因子</Button>}{application?.status === "waiting_flat" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancelEvolutionReplacement(application.id).then(result => {setApplication(null); setMessage(result.status === "cancelled" ? "已取消待生效替换" : "当前没有待生效替换，可能已生效，请刷新查看")}).catch(e => setError(String(e)))}>取消待生效替换</Button>}</div><p className="text-[11px] text-[var(--text-muted)]">结果仅在点击后应用。任务替换保留原风控与交易参数，未平仓时继续用原配方处理持仓。</p></section>}
          <section className={`${box} p-4 space-y-3`}><h2 className="text-sm font-medium">迭代记录 <span className="text-[10px] text-[var(--text-muted)] font-normal">最近 100 轮 · 总尝试 {job.round}</span></h2>{job.reports.length === 0 ? <p className="text-xs text-[var(--text-muted)]">日志复盘完成后开始生成候选。</p> : [...job.reports].reverse().map(r => <div key={r.round} className="border-t border-[var(--border)] pt-2 text-xs"><button type="button" className="flex w-full items-center justify-between text-left gap-2" onClick={() => setExpanded(expanded === r.round ? null : r.round)}><span>第 {r.round} 轮 · {r.recipe?.groups.length ?? 0} 成员</span><span className={r.sealed?.passed ? "text-up" : "text-[var(--text-muted)]"}>{r.error ? "配方无效" : r.sealed ? r.sealed.passed ? "封存通过" : "封存失败" : r.validation?.passed ? "验证通过" : "验证未通过"} · {expanded === r.round ? "收起" : "详情"}</span></button>{expanded === r.round && <div className="mt-2 space-y-2 text-[var(--text-muted)]"><p className="font-mono break-all">{r.text}</p><p>{r.recipe?.rationale || r.error}</p><EvolutionResearchReport report={r}/>{!!r.format_repairs && <p>本轮已进行一次配方格式纠正</p>}{r.validation && <p>验证年化 {pct(r.validation.validation?.ann_ret)} · Sortino {r.validation.validation?.sortino.toFixed(2)} · 双倍成本 {pct(r.validation.validation?.stress_ann_ret)} · WF 正收益比例 {pct(r.validation.wf_consistency)}</p>}<pre className="text-[10px] whitespace-pre-wrap break-all">{r.recipe ? JSON.stringify({groups: r.recipe.groups, weights: r.recipe.weights}) : r.proposal ? JSON.stringify(r.proposal) : ""}</pre></div>}</div>)}</section>
        </>}
      </div>
    </div>
  </div>
}
