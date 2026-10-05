import { createRoot } from "react-dom/client"
import { useState } from "react"
import { KlineChart } from "@/components/market/kline-chart"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { useIndicatorStore } from "@/stores/indicator"
import { calcPivotSignals } from "@/lib/pivot-signals"
import fixture from "@/lib/fixtures/dot60_okx_swap_2026-10-05.json"
import "../src/app/globals.css"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收5187")
const bars = fixture.okx_swap.map(b => ({ ...b, market_source: "okx" as const, version: 100, kind: "correction" }))
const EMPTY_BARS: typeof bars = []
let price = bars.at(-1)!.close
let requests = 0
const canonical = () => bars.map((b, i) => i === bars.length - 1 ? { ...b, close: price, high: Math.max(b.high, price), version: 100 + requests } : b)
localStorage.setItem("qihuo.kline-history.v1", JSON.stringify({ dotusdt: { fetchedAt: Date.now(), periods: { "60m": [{ ...bars.at(-1)!, market_source: "binance_spot", high: 999 }] } } }))
globalThis.fetch = async input => {
  const url = new URL(String(input), location.origin)
  if (url.pathname === "/api/market/kline/bundle") {
    requests++
    return Response.json({ symbol: "dotusdt", periods: ["1m","5m","15m","30m","60m"].map(period => ({ period, bars: period === "60m" ? canonical() : [], has_more: false })) })
  }
  if (url.pathname === "/api/market/kline") {
    requests++
    const period = url.searchParams.get("period")
    const daily = [...new Map(canonical().map(b => [b.time.slice(0, 10), { ...b, time: b.time.slice(0, 10) }])).values()]
    return Response.json({ symbol: "dotusdt", period, bars: period === "60m" ? canonical().slice(-Number(url.searchParams.get("limit") || 240)) : daily, has_more: false })
  }
  throw new Error(`隔离验收禁止真实API: ${url.pathname}`)
}
useAppStore.setState({ activeContract: "dotusdt" })
const current = useIndicatorStore.getState().config
useIndicatorStore.setState({ config: { ...current, pivot: { ...current.pivot, enabled: true, left: 6, right: 6, minRightLive: 2 }, pivotVersion: "v1" } })
function Preview() {
  const data = useMarketStore(s => s.klineBars.dotusdt?.["60m"] ?? EMPTY_BARS)
  const rt = useMarketStore(s => s.klineRealtime.dotusdt?.["60m"])
  const [injected,setInjected] = useState(false)
  const p = fixture.params
  const signals = calcPivotSignals(data, p.left, p.right, { alternate:true,minAmplitudePct:p.min_amplitude_pct,minAtrMult:p.min_atr_mult,atrPeriod:p.atr_period,minRightLive:p.min_right_live })
  return <main className="p-4 space-y-3">
    <p>OKX 永续 · DOT 60分钟 · L6／R6／预确认2 · 真实公开行情夹具</p>
    <output data-testid="source">{data.length}根 · {data.at(-1)?.market_source} · 最新枢轴 {signals.at(-1)?.side} · {signals.at(-1)?.time}</output>
    <output data-testid="realtime">{rt?.market_source} · {rt?.close}</output>
    <button onClick={() => { price = Math.min(bars.at(-1)!.high, price + .0001) }}>更新模拟 OKX 当前价</button>
    <button onClick={() => {
      useMarketStore.getState().updateKlineRealtime([{symbol:"dotusdt",period:"60m",bar:{...bars.at(-1)!,market_source:"binance_spot",high:999,close:999,version:999999}}])
      setInjected(true)
    }}>注入旧现货帧</button>{injected && <span>已尝试注入</span>}
    <div style={{height:650}}><KlineChart userTradeLines="off" /></div>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
