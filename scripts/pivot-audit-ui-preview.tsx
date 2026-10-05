import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { KlineChart } from "@/components/market/kline-chart"
import { CreateQuantParams } from "@/components/ai-trading/form/create-quant-params"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { useIndicatorStore } from "@/stores/indicator"
import { calcChartPivotSignals } from "@/lib/pivot-signals"
import { DEFAULT_QUANT_PARAMS, buildStrategyParams } from "@/lib/quant-strategy"
import type { KlineBar } from "@/types"
import "../src/app/globals.css"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收5187")
const rows: KlineBar[] = Array.from({ length: 240 }, (_, i) => {
  const p = i <= 233 ? 100 + (233-i)*.02 : 100+i-233
  return { time: new Date(Date.UTC(2026, 8, 25, i)).toISOString().slice(0,19).replace("T", " "), open: p, high: p+1, low: i === 233 ? 90 : p-1, close: p, volume: 1, market_source: "okx", is_closed: i < 239 }
})
let confirmed = false, broken = false, version = Date.now()
const current = () => rows.map((b, i) => ({ ...b, version: ++version, kind: "correction", ...(i === 239 ? { is_closed: confirmed, low: broken ? 89 : b.low } : {}) }))
globalThis.fetch = async input => {
  const u = new URL(String(input), location.origin)
  if (u.pathname === "/api/market/kline/bundle") return Response.json({ symbol: "dotusdt", periods: ["1m","5m","15m","30m","60m"].map(period => ({ period, bars: period === "60m" ? current() : [], has_more: false })) })
  if (u.pathname === "/api/market/kline") {
    const period = u.searchParams.get("period")
    const daily = [...new Map(current().map(b => [b.time.slice(0,10), { ...b, time: b.time.slice(0,10) }])).values()]
    return Response.json({ symbol: "dotusdt", period, bars: period === "60m" ? current().slice(-Number(u.searchParams.get("limit") || 240)) : daily, has_more: false })
  }
  throw new Error("隔离验收禁止真实API")
}
useAppStore.setState({ activeContract: "dotusdt" })
const empty: KlineBar[] = []
function Preview() {
  const [q, setQ] = useState({ ...DEFAULT_QUANT_PARAMS, quantKind: "swing_pivot" as const, swingLeft: 6, swingRight: 6, swingMinRightLive: 2 })
  useEffect(() => {
    const c = useIndicatorStore.getState().config
    useIndicatorStore.setState({ config: { ...c, pivotVersion: "v1", pivot: { ...c.pivot, enabled: true, left: 6, right: 6, minRightLive: q.swingMinRightLive, alternate: q.swingAlternate } } })
  }, [q.swingMinRightLive, q.swingAlternate])
  const bars = useMarketStore(s => s.klineBars.dotusdt?.["60m"] ?? empty)
  const rt = useMarketStore(s => s.klineRealtime.dotusdt?.["60m"])
  const data = rt && bars.length ? [...bars.slice(0,-1), rt] : bars
  const sig = calcChartPivotSignals(data, 6, 6, { alternate: q.swingAlternate, minAmplitudePct: 1.5, minAtrMult: 1.5, atrPeriod: 14, minRightLive: q.swingMinRightLive }).at(-1)
  return <main className="p-4 space-y-3">
    <p>隔离验收 · L6/R6 · 盘中预确认与收盘正式确认 · 不连接交易账户</p>
    <div className="flex gap-4"><button onClick={() => setQ({ ...q, swingMinRightLive: 2 })}>预确认2</button><button onClick={() => setQ({ ...q, swingMinRightLive: 6 })}>仅正式6</button><button onClick={() => { confirmed = true }}>确认第6根收盘</button><button onClick={() => { broken = true }}>破坏盘中波谷</button></div>
    <output data-testid="signal">{data.length}根 · {sig ? `${sig.side} · ${sig.provisional ? "预确认" : "正式确认"}` : "无信号"}</output>
    <div className="grid grid-cols-[280px_1fr] gap-4"><div><CreateQuantParams quant={q} onQuant={v => setQ({ ...v, quantKind: "swing_pivot" })} /><output data-testid="params">{JSON.stringify(buildStrategyParams(q))}</output></div><div style={{ height: 620 }}><KlineChart userTradeLines="off" /></div></div>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
