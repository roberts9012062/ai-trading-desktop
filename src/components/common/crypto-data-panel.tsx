"use client"

import { useEffect, useState } from "react"
import { fetchBookSnapshot, type BookSnapshot } from "@/lib/crypto-direct"

const STORAGE_KEY = "atd_book_observations_v1"
const MAX_SAMPLES = 2000

/** Observations are saved separately from mining history: no retrospective book backfill. */
export function CryptoDataPanel({ channel, symbol }: { channel: string; symbol: string }): React.JSX.Element | null {
  const [running, setRunning] = useState(false)
  const [sample, setSample] = useState<BookSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const supported = channel === "gate_usdt" || channel === "gate_spot" || channel === "binance_spot"

  useEffect(() => { setRunning(false); setSample(null); setError(null); setCount(0) }, [channel, symbol])
  useEffect(() => {
    if (!running || !supported || !symbol.trim()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function collect(): Promise<void> {
      try {
        const next = await fetchBookSnapshot(channel as BookSnapshot["channel"], symbol)
        if (cancelled) return
        const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
        const history = Array.isArray(raw) ? raw.slice(-(MAX_SAMPLES - 1)) as BookSnapshot[] : []
        history.push(next)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
        setSample(next)
        setCount(history.filter((r) => r.channel === next.channel && r.symbol === next.symbol).length)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "盘口读取或本地保存失败")
      } finally {
        if (!cancelled) timer = setTimeout(() => void collect(), 10_000)
      }
    }
    void collect()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [running, supported, channel, symbol])

  if (channel === "okx") return <p className="text-[11px] text-[var(--text-muted)]">OKX 官方 K线和已结算资金费率由本机下载并缓存，历史从2023-07起，近期归档有发布延迟。缺失资金费标记为空；持仓量、盘口和强平历史不由其他交易所代填。短线逐笔成交与 K线同源。</p>
  if (channel === "binance_usdt") return <p className="text-[11px] text-[var(--text-muted)]">Binance USDT 永续官方 K线、聚合成交与资金费率由本机直连下载，与 OKX 分开缓存，不转发服务器。历史从2019-09起，具体品种以上市日为准；近期 K线有发布延迟，资金费率月包未发布时标记缺失。持仓量、盘口和强平历史不代填。</p>
  if (!supported) return null
  function download(): void {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
      const rows = Array.isArray(raw) ? raw.filter((r: BookSnapshot) => r.channel === channel && r.symbol === sample?.symbol) : []
      const url = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }))
      const a = document.createElement("a")
      a.href = url; a.download = `book-${channel}-${sample?.symbol}.json`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setError("本地盘口记录导出失败") }
  }
  return (
    <div className="space-y-1 text-[11px] text-[var(--text-muted)]">
      <p>{channel === "gate_usdt"
        ? "历史输入：已结算资金费率、持仓量、主动买卖统计、多空账户比、清算不平衡和成交额。接口仅近180天，预留对齐窗口后支持最近175天；默认日线120天、其他周期30天。资金费率仅作因子输入，收益尚未扣除资金费用。"
        : (channel as string) === "binance_usdt" ? "历史输入：Binance USDT-M 永续本尊K线（成交额/主动买卖/笔数随线附带）+ 归档资金费率（2019-09 起，近端滞后 1-2 天）。持仓量类特征该渠道不提供。资金费率仅作因子输入，收益尚未扣除资金费用。"
        : channel === "binance_spot" ? "历史输入：成交额、主动买入量及成交笔数随K线直连获取。现货不混入其他交易所的资金费率。" : "历史输入：成交额随K线直连获取。"}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" disabled={!symbol.trim()} onClick={() => setRunning((v) => !v)} className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40">
          {running ? "停止盘口采集" : "开始盘口直连采集"}
        </button>
        {sample && <button type="button" onClick={download} className="underline">导出记录（{count}）</button>}
      </div>
      <p>每10秒采集买卖盘前20档摘要，离开页面停止；本机最多保留最近2000条。仅从现在积累，不用于回填历史挖掘。</p>
      {sample && <p>最近采样 {new Date(sample.received_at).toLocaleTimeString()} · 买一 {sample.bid} / 卖一 {sample.ask} · 价差 {sample.spread_bps.toFixed(3)} bp · 深度不平衡 {sample.imbalance.toFixed(3)}</p>}
      {error && <p role="status" className="text-amber-500">{error}</p>}
    </div>
  )
}
