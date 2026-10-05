"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { NumericInput } from "@/components/ui/numeric-input"
import { withNumericValidation } from "@/lib/numeric-input"
import { getLiveFeeRatesApi } from "@/lib/live-api"
import { buildShortlinePayload } from "@/lib/shortline/mount"
import { reviewShortlineExecution } from "@/lib/shortline/server-api"
import { boundedReviewDays, REVIEW_REASONS, type ExecutionReview, type ExecutionSettings, type ExecutionObservation } from "@/lib/shortline/execution-review"
import type { CadenceSeconds, ShortlineTimeframe } from "@/lib/shortline/spec"

export const ENHANCED_SHORTLINE_DECISION = { exit_threshold: .1, neutral_exit_steps: 6,
  trailing_start_pct: 8, trailing_giveback_pct: 40, stop_reentry_new_signal: true, market_execution: true }

interface Props {
  taskId?: string, symbol: string, timeframe: ShortlineTimeframe, cadence: CadenceSeconds,
  champions: { id: number, tokens: number[] }[], settings: ExecutionSettings,
  onSettings: (value: ExecutionSettings) => void,
  feeRate: number, onFeeRate: (value: number) => void,
  disabled: boolean, onReport: (value: ExecutionReview | null) => void,
}
const n = (value: number | null, digits = 2) => value == null ? "—" : value.toFixed(digits)

export default function ShortlineExecutionPanel(props: Props) {
  const { settings, onSettings } = props
  const [days, setDays] = useState(14)
  const [slippage, setSlippage] = useState(2)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [feeMessage, setFeeMessage] = useState("默认按吃单5bp估算；可读取绑定账户费率")
  const [report, setReport] = useState<ExecutionReview | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const identity = JSON.stringify([props.taskId, props.symbol, props.timeframe, props.cadence,
    props.champions, settings, props.feeRate, slippage, days])
  const fingerprintRef = useRef(identity)
  fingerprintRef.current = identity
  useEffect(() => {
    workerRef.current?.terminate()
    abortRef.current?.abort()
    setBusy(false); setReport(null); props.onReport(null); setMessage("")
    return () => { workerRef.current?.terminate(); abortRef.current?.abort() }
  }, [identity])
  const payload = useMemo(() => props.champions.length ? buildShortlinePayload({
    symbol: props.symbol, timeframe: props.timeframe, cadence: props.cadence,
    champions: props.champions, decision: ENHANCED_SHORTLINE_DECISION,
    evalVersion: "shortline-eval-v2",
    risk: { max_notional_usdt: settings.margin * settings.leverage },
  }, "0".repeat(64)) : null, [identity])

  const loadFee = async () => {
    setFeeMessage("读取OKX绑定账户费率…")
    try {
      const rows = await getLiveFeeRatesApi("okx", props.symbol.toLowerCase())
      const row = rows.find((r) => r.symbol.toLowerCase() === props.symbol.toLowerCase()) ?? rows[0]
      if (!row || !Number.isFinite(row.taker)) throw new Error("无账户费率")
      // Existing fee API returns signed percentages, not fractional rates.
      const rate = Math.abs(row.taker) / 100
      props.onFeeRate(rate)
      setFeeMessage(`OKX账户吃单费率 ${(rate * 10000).toFixed(2)}bp；回放按吃单成本保守计算`)
    } catch (e) { setFeeMessage(`费率读取失败，保留当前估算：${e instanceof Error ? e.message : String(e)}`) }
  }
  const stop = () => {
    workerRef.current?.terminate(); workerRef.current = null
    abortRef.current?.abort(); setBusy(false); setMessage("回放已停止")
  }
  const start = () => {
    if (!payload) return
    setBusy(true); setReport(null); props.onReport(null)
    setMessage("冻结组合与参数，读取本地逐笔归档…")
    const currentIdentity = identity
    const controller = new AbortController()
    abortRef.current = controller
    const worker = new Worker(new URL("../../lib/shortline/execution-review.worker.ts", import.meta.url), { type: "module" })
    workerRef.current = worker
    worker.onerror = (event) => { setBusy(false); setMessage(`回放失败：${event.message}`); worker.terminate() }
    worker.onmessage = async ({ data }: MessageEvent<{
      progress?: string, error?: string, done?: boolean,
      observations?: ExecutionObservation[], datasetSha?: string,
    }>) => {
      if (fingerprintRef.current !== currentIdentity || controller.signal.aborted) return
      if (data.progress) setMessage(data.progress)
      if (data.error) { setBusy(false); setMessage(`回放失败：${data.error}`); worker.terminate() }
      if (data.done && data.observations && data.datasetSha) {
        worker.terminate(); workerRef.current = null
        setMessage(`已生成${data.observations.length.toLocaleString()}个因果步点，服务器复核开平仓与成本…`)
        try {
          const value = await reviewShortlineExecution({
            ...settings, payload, steps: data.observations, dataset_sha: data.datasetSha,
            source: "binance_usdt", fee_rate: props.feeRate, slippage_bps: slippage,
          }, controller.signal)
          if (fingerprintRef.current !== currentIdentity || controller.signal.aborted) return
          setReport(value); props.onReport(value); setMessage("研究回放复核完成；结论不构成OKX实盘盈利保证")
        } catch (e) {
          if (!controller.signal.aborted) setMessage(`服务器复核失败：${e instanceof Error ? e.message : String(e)}`)
        } finally { if (!controller.signal.aborted) setBusy(false) }
      }
    }
    worker.postMessage({ symbol: props.symbol, timeframe: props.timeframe,
      cadence: props.cadence, champions: props.champions, days })
  }
  const update = (patch: Partial<ExecutionSettings>) => onSettings({ ...settings, ...patch })
  const inputClass = "w-full rounded-lg border border-white/10 bg-[#0F131C] px-3 py-2 text-sm text-white"
  const field = (label: string, value: number, onChange: (v: number) => void, min: number, max: number, step = 1) => (
    <label className="space-y-2 text-xs text-gray-400">{label}
      <NumericInput type="number" className={inputClass} value={value} min={min} max={max} step={step}
        disabled={busy || props.disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
  return <section className="rounded-2xl border border-sky-400/20 bg-[#1E2636]/50 p-6 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-medium text-sky-300">短线执行复核 · 净收益优先</h2>
      <span className="text-xs text-gray-500">入场±0.25 / 3步 · 中性退出±0.10 / 6步 · 单根一次动作</span>
    </div>
    <p className="text-xs text-gray-400 leading-relaxed">新任务采用入场/退出迟滞，弱信号不立即退出；反向确认、止损和锁利优先。按吃单执行，开仓附带任务止损；止损后等新信号再入场。参数同时用于回放与本页新建任务。已运行任务保持原配置。</p>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {field("单笔保证金（USDT）", settings.margin, (margin) => update({margin}), 1, 1000000)}
      {field("杠杆（1–50倍）", settings.leverage, (leverage) => update({leverage}), 1, 50)}
      <label className="space-y-2 text-xs text-gray-400">保证金模式<select className={inputClass} value={settings.margin_mode}
        disabled={busy || props.disabled} onChange={(e) => update({margin_mode:e.target.value as ExecutionSettings["margin_mode"]})}>
        <option value="isolated">逐仓</option><option value="cross">全仓</option></select></label>
      {field("保证金止损（%，0关闭）", settings.stop_loss_pct, (stop_loss_pct) => update({stop_loss_pct}), 0, 100)}
      {field("保证金止盈（%，0关闭）", settings.take_profit_pct, (take_profit_pct) => update({take_profit_pct}), 0, 1000)}
      {field("单边吃单费用（小数）", props.feeRate, props.onFeeRate, 0, .01, .0001)}
      {field("单边滑点/价差估算（bp）", slippage, setSlippage, 0, 100, .5)}
      {field("复核天数（最多60天）", days, setDays, 1, 60)}
    </div>
    <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400">
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.profit_lock.enabled} disabled={busy || props.disabled}
        onChange={(e) => update({profit_lock:{...settings.profit_lock,enabled:e.target.checked}})} />自动锁利：净收益5%激活</label>
      <label className="flex items-center gap-2">锁利冷却信号<select className="rounded bg-[#0F131C] p-1" value={settings.profit_lock.cooldown_signals}
        disabled={busy || props.disabled} onChange={(e) => update({profit_lock:{...settings.profit_lock,cooldown_signals:Number(e.target.value)}})}>
        {[0,1,2,3,4,5].map((v) => <option key={v} value={v}>{v}次</option>)}</select></label>
      <button className="text-sky-300 disabled:opacity-50" disabled={busy || props.disabled} onClick={() => void loadFee()}>读取OKX账户费率</button>
      <span>{feeMessage}</span>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button className="rounded-lg border border-sky-400/40 px-4 py-2 text-sm text-sky-300 disabled:opacity-40"
        disabled={busy || props.disabled || !payload} onClick={withNumericValidation(start)}>复核当前挂载组合</button>
      {busy && <button className="text-sm text-red-300" onClick={stop}>停止回放</button>}
      <span className="text-xs text-gray-400">{message || `按当前节奏最多复核${boundedReviewDays(days, props.cadence)}天；另留完整预热历史`}</span>
    </div>
    {report && <div className="space-y-3 border-t border-white/10 pt-4">
      <div className="flex flex-wrap justify-between gap-3 text-xs">
        <span className="text-amber-300">研究复核 · Binance逐笔历史 · 尚未独立验证OKX</span>
        <button className="text-sky-300" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:"application/json"}))
          const a = document.createElement("a"); a.href = url; a.download = `shortline-review-${report.review_sha.slice(0,12)}.json`; a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}>导出成交回放与冻结参数</button>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-xs text-gray-300"><thead><tr className="text-gray-500 text-right">
        <th className="text-left p-2">口径</th><th>轮次</th><th>净盈亏U</th><th>净胜率</th><th>实际盈亏比</th><th>净利润因子</th><th>每轮净期望U</th><th>最大回撤U</th>
      </tr></thead><tbody>{[["基准",report.base.metrics],["双倍成本＋延迟",report.stress.metrics],
        ...report.periods.map((m,i) => [`复核${i === 0 ? "前" : "后"}半段`,m])].map(([label, value]) => {
        const m = value as ExecutionReview["base"]["metrics"]
        return <tr key={label as string} className="border-t border-white/5 text-right"><td className="text-left p-2">{label as string}</td>
          <td>{m.closed_trades}</td><td className={m.net_profit >= 0 ? "text-emerald-300" : "text-red-300"}>{n(m.net_profit)}</td>
          <td>{n(m.win_rate*100)}%</td><td>{n(m.payoff_ratio)}:1</td><td>{n(m.profit_factor)}</td><td>{n(m.expectancy)}</td><td>{n(m.max_drawdown)}</td></tr>
      })}</tbody></table></div>
      <ul className="text-xs text-amber-200/80 space-y-1">{report.reasons.map((r) => <li key={r}>• {REVIEW_REASONS[r] ?? r}</li>)}</ul>
      <p className="text-xs text-gray-500">按后续观察成交，扣开平仓费与逆向滑点；不把未平仓浮盈计为胜率。已知资金费事件按现金流计入，当前归档没有完整资金费。未模拟盘口队列/部分成交，前后段复核也不等于独立封存验收。</p>
    </div>}
  </section>
}
