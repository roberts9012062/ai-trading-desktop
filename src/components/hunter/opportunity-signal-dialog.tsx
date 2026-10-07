"use client"

/**
 * 猎手机会信号图弹窗：K线＋MA20＋MACD(12,26,9)，
 * 对构成信号的连续实体K线加描边，并给出三项条件清单；
 * 未成交的挂载机会可一键「立即开仓」。
 */

import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { hunterApi, type Hunter, type HunterData, type Opportunity } from "@/lib/hunter/api"
import { buildSignalView } from "@/lib/hunter/signal-view"
import { hunterCycleLabel, type MacdPeriod } from "@/lib/hunter/macd-ma20"
import { useHunterStore } from "@/stores/hunter"
import { useAITradingStore } from "@/stores/ai-trading"

const UP = "#ef4444", DOWN = "#22c55e", MA_LINE = "#eab308", DIF_LINE = "#3b82f6", DEA_LINE = "#f97316"
const OUTLINE = "#f59e0b"
const money = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 6 })
const countdown = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(s/60)).padStart(2, "0")}:${String(s%60).padStart(2, "0")}`
}

function canManualEntry(group: Hunter, o: Opportunity): boolean {
  return group.status === "running" && Boolean(o.finished_at) && !o.runtime.initial_qty
    && !o.runtime.entry && Date.now()/1000 - Date.parse(o.finished_at ?? "")/1000 < 2*3600
}

export function OpportunitySignalDialog({ group, opportunity, onClose }: {
  group: Hunter; opportunity: Opportunity | null; onClose: () => void
}) {
  const [data, setData] = useState<HunterData | null>(null)
  const [ticker, setTicker] = useState<{ price: number; ts_ms: number } | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [, setHeartbeat] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manualNote, setManualNote] = useState<string | null>(null)
  const refresh = useHunterStore(s => s.refresh)
  const o = opportunity
  useEffect(() => {
    if (!o) return
    const id = setInterval(() => setHeartbeat(t => t+1), 1000)
    return () => clearInterval(id)
  }, [o?.id])
  useEffect(() => {
    if (!o) return
    const abort = new AbortController()
    let alive = true
    setData(null); setTicker(null); setError(null); setManualNote(null); setUpdatedAt(null)
    const load = () => {
      hunterApi.data(group.id, o.symbol, o.cycle as MacdPeriod, abort.signal).then(rows => {
        if (alive) { setData(rows); setUpdatedAt(Date.now()) }
      }).catch(e => { if (alive) setError(e instanceof Error ? e.message : "行情加载失败") })
      hunterApi.universe(group.id, abort.signal).then(list => {
        if (alive) setTicker(list.find(t => t.symbol === o.symbol) ?? null)
      }).catch(() => {})
    }
    load()
    const id = setInterval(load, 5000)
    return () => { alive = false; clearInterval(id); abort.abort() }
  }, [o?.id, group.id])
  const view = useMemo(() => data && o ? buildSignalView(data.bars[o.cycle] ?? [], o.cycle as MacdPeriod, data.now) : null,
    [data, o?.id, o?.cycle])
  const manual = async () => {
    if (!o) return
    setBusy(true); setError(null); setManualNote(null)
    try {
      await hunterApi.manualEntry(group.id, o.id)
      await refresh(new AbortController().signal)
      await useAITradingStore.getState().loadTasks({ silent: true })
      setManualNote("已确认立即开仓：服务器复验信号后下单，几秒内可在明细中查看")
    } catch (e) {
      setError(e instanceof Error ? e.message : "立即开仓失败")
    } finally { setBusy(false) }
  }
  if (!o) return null
  const isShort = o.plan.direction === "short"
  const showManual = canManualEntry(group, o)
  const livePrice = ticker && ticker.price > 0 ? ticker.price : null
  const nextClose = view ? view.lastClosedAt + (o.cycle === "60m" ? 3600 : 1800) : 0
  const remaining = nextClose ? nextClose - Date.now()/1000 : 0
  return <Dialog open={Boolean(o)} onOpenChange={v => { if (!v && !busy) onClose() }}>
    <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{o.symbol.toUpperCase()} · {hunterCycleLabel(o.cycle)} · {isShort ? "做空信号" : "做多信号"}</DialogTitle>
        <DialogDescription>
          每 5 秒自动刷新；MACD(12,26,9) 与 SMA20 只使用已收盘K线，红涨绿跌；描边K线为实体严格站上/处于 MA20 {isShort ? "下方" : "上方"}的连续计数，影线可触线。{showManual ? "该机会挂载后未成交，可立即按当前信号开仓。" : ""}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs" aria-label="实时状态">
        <span>实时价 <strong className="font-num">{livePrice != null ? money(livePrice) : "—"}</strong></span>
        <span className="text-[var(--text-muted)]">最近收盘 {money(o.runtime.last_price ?? view?.points.at(-1)?.close ?? 0)}</span>
        <span className="text-[var(--text-muted)]">下一根收盘还有 <strong className="font-num">{countdown(remaining)}</strong></span>
        <span className="text-[var(--text-muted)]">更新于 {updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN") : "—"}</span>
      </div>
      {view ? <SignalChart view={view} plan={o.plan} livePrice={livePrice} /> :
        error ? <p role="alert" className="text-xs text-red-400">{error}</p> :
        <p className="text-xs text-[var(--text-muted)]">行情加载中…</p>}
      {view && <ConditionList view={view} isShort={isShort} leverage={group.config.leverage} />}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>计划入场<span className="block text-base mt-1">{money(o.plan.entry)}</span></div>
        <div>保护止损<span className="block text-base mt-1">{typeof o.plan.stop === "number" ? money(o.plan.stop) : "兜底止损关闭"}</span></div>
        <div>杠杆<span className="block text-base mt-1">{o.plan.leverage ?? group.config.leverage} 倍</span></div>
        <div>数量<span className="block text-base mt-1">{money(o.plan.quantity)}</span></div>
      </div>
      {manualNote && <p className="text-xs text-emerald-400">{manualNote}</p>}
      <div className="flex justify-end gap-2">
        {showManual && <Button disabled={busy} onClick={() => void manual()}>{busy ? "提交中…" : "立即开仓（按当前信号与报价）"}</Button>}
        <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
      </div>
    </DialogContent>
  </Dialog>
}

function ConditionList({ view, isShort, leverage }: { view: ReturnType<typeof buildSignalView>; isShort: boolean; leverage: number }) {
  const item = (ok: boolean, text: string) => <p className={ok ? "text-emerald-400" : "text-[var(--text-muted)]"}>
    {ok ? "✓" : "✗"} {text}{ok ? "" : "（未成立）"}</p>
  return <div className="rounded-md border border-[var(--border)] p-3 text-xs space-y-1">
    <p className="font-medium">{isShort ? "做空入场条件（当前盘面）" : "做多入场条件（当前盘面）"}</p>
    {isShort ? <>
      {item(view.macdDead, "MACD 处于死叉状态：DIF 低于 DEA（不要求刚死叉）")}
      {item(view.maFalling, "MA20 拐头向下：最新已收盘K线的 MA20 低于上一根，持平不算向下")}
      {item(view.streakSide === "short" && (view.streakCount === 2 || view.streakCount === 3),
        `连续 ${view.streakCount} 根实体在 MA20 下方（仅 2–3 根可入场，4 根及以上不追空）`)}
      {item(view.ma20GapPct != null && view.ma20GapPct*leverage <= 4,
        `MA20 距离守卫：开盘价距 MA20 ${view.ma20GapPct?.toFixed(3)}% × ${leverage} 倍 = ${view.ma20GapPct != null ? (view.ma20GapPct*leverage).toFixed(2) : "—"}% 保证金，须 ≤ 4%`)}
    </> : <>
      {item(view.macdFreshGolden, "MACD 新金叉：上一根 DIF 不高于 DEA，最新一根高于")}
      {item(view.maRising, "MA20 向上：最新高于上一根，上一根不低于再前一根")}
      {item(view.streakSide === "long" && (view.streakCount === 3 || view.streakCount === 4),
        `连续 ${view.streakCount} 根实体在 MA20 上方（仅 3–4 根可入场，超过 4 根跳过）`)}
    </>}
    <p className="text-[var(--text-muted)]">最近收盘K线：{view.lastClosedAt ? new Date(view.lastClosedAt*1000).toLocaleString("zh-CN") : "无"}；
    {view.longSignal ? " 当前满足完整做多信号" : view.shortSignal ? " 当前满足完整做空信号" : " 当前不构成完整入场信号"}。</p>
  </div>
}

function SignalChart({ view, plan, livePrice }: { view: ReturnType<typeof buildSignalView>; plan: Opportunity["plan"]; livePrice: number | null }) {
  const width = 880, priceH = 300, macdH = 110, padL = 8, padR = 64, padY = 8
  const points = view.points
  if (points.length < 2) return <p className="text-xs text-[var(--text-muted)]">K线数据不足</p>
  const lows = points.map(p => Math.min(p.low, p.ma20 ?? p.low)), highs = points.map(p => Math.max(p.high, p.ma20 ?? p.high))
  const hasStop = typeof plan.stop === "number" && plan.stop > 0
  const hasEntry = typeof plan.entry === "number" && plan.entry > 0
  if (hasStop) { lows.push(plan.stop!); highs.push(plan.stop!) }
  if (hasEntry) { lows.push(plan.entry!); highs.push(plan.entry!) }
  if (livePrice != null) { lows.push(livePrice); highs.push(livePrice) }
  const minP = Math.min(...lows), maxP = Math.max(...highs), spanP = maxP-minP || 1
  const macdVals = points.flatMap(p => [p.dif, p.dea]).filter(Number.isFinite)
  const maxM = Math.max(...macdVals.map(Math.abs), 1e-9)
  const innerW = width-padL-padR, step = innerW/points.length, candleW = Math.max(1.5, step*.62)
  const x = (i: number) => padL+step*(i+.5)
  const yP = (v: number) => padY+(1-(v-minP)/spanP)*(priceH-2*padY)
  const yM = (v: number) => padY+(1-(v+maxM)/(2*maxM))*(macdH-2*padY)
  const maPath = points.map((p, i) => p.ma20 == null ? "" : `${i && points[i-1].ma20 != null ? "L" : "M"}${x(i).toFixed(1)},${yP(p.ma20).toFixed(1)}`).join(" ")
  const difPath = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yM(p.dif).toFixed(1)}`).join(" ")
  const deaPath = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yM(p.dea).toFixed(1)}`).join(" ")
  const last = points[points.length-1]
  return <div className="rounded-md border border-[var(--border)] p-2 overflow-x-auto" aria-label="信号K线图">
    <svg viewBox={`0 0 ${width} ${priceH+macdH+26}`} className="w-full min-w-[640px]" role="img" aria-label={`${plan.direction === "short" ? "做空" : "做多"}信号K线与MACD`}>
      {points.map((p, i) => {
        const up = p.close >= p.open, color = up ? UP : DOWN
        const inStreak = view.streakFrom != null && i >= view.streakFrom
        const top = yP(Math.max(p.open, p.close)), bottom = yP(Math.min(p.open, p.close))
        const bodyH = Math.max(1, bottom-top)
        return <g key={p.ts}>
          <line x1={x(i)} x2={x(i)} y1={yP(p.high)} y2={yP(p.low)} stroke={color} strokeWidth={1} />
          <rect x={x(i)-candleW/2} y={top} width={candleW} height={bodyH} fill={color} />
          {inStreak && <rect x={x(i)-candleW/2-2} y={top-2} width={candleW+4} height={bodyH+4}
            fill="none" stroke={OUTLINE} strokeWidth={1.6} rx={1} />}
        </g>
      })}
      <path d={maPath} fill="none" stroke={MA_LINE} strokeWidth={1.4} />
      {hasEntry && <g><line x1={padL} x2={width-padR} y1={yP(plan.entry!)} y2={yP(plan.entry!)} stroke="#94a3b8" strokeDasharray="5 4" strokeWidth={1} />
        <text x={width-padR+4} y={yP(plan.entry!)+4} fontSize={10} fill="#94a3b8">入场 {money(plan.entry!)}</text></g>}
      {livePrice != null && <g><line x1={padL} x2={width-padR} y1={yP(livePrice)} y2={yP(livePrice)} stroke="#38bdf8" strokeWidth={1} />
        <text x={width-padR+4} y={yP(livePrice)+4} fontSize={10} fill="#38bdf8">实时 {money(livePrice)}</text></g>}
      {hasStop && <g><line x1={padL} x2={width-padR} y1={yP(plan.stop!)} y2={yP(plan.stop!)} stroke={DOWN} strokeDasharray="5 4" strokeWidth={1} />
        <text x={width-padR+4} y={yP(plan.stop!)+4} fontSize={10} fill={DOWN}>止损 {money(plan.stop!)}</text></g>}
      <text x={width-padR+4} y={yP(last.close)+4} fontSize={10} fill="#cbd5e1">{money(last.close)}</text>
      <text x={width-padR+4} y={last.ma20 != null ? yP(last.ma20)+4 : 12} fontSize={10} fill={MA_LINE}>MA20</text>
      <g transform={`translate(0,${priceH+22})`}>
        <line x1={padL} x2={width-padR} y1={yM(0)} y2={yM(0)} stroke="var(--border)" strokeWidth={1} />
        {points.map((p, i) => {
          const hist = p.dif-p.dea
          if (!Number.isFinite(hist) || hist === 0) return null
          const y0 = yM(0), y1 = yM(hist)
          return <rect key={p.ts} x={x(i)-candleW/2} y={Math.min(y0, y1)} width={candleW} height={Math.max(1, Math.abs(y1-y0))}
            fill={hist > 0 ? UP : DOWN} opacity={.55} />
        })}
        <path d={difPath} fill="none" stroke={DIF_LINE} strokeWidth={1.3} />
        <path d={deaPath} fill="none" stroke={DEA_LINE} strokeWidth={1.3} />
        <text x={width-padR+4} y={yM(points[points.length-1].dif)+4} fontSize={10} fill={DIF_LINE}>DIF</text>
        <text x={width-padR+4} y={yM(points[points.length-1].dea)+4} fontSize={10} fill={DEA_LINE}>DEA</text>
      </g>
      <g transform={`translate(0,${priceH+6})`}>
        <text x={padL} y={10} fontSize={10} fill="#94a3b8">MACD(12,26,9)</text>
        <text x={padL+90} y={10} fontSize={10} fill={OUTLINE}>▮ 描边 = 信号连续实体</text>
      </g>
    </svg>
  </div>
}
