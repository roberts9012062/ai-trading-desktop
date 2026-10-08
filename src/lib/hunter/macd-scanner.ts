import { hunterApi, type Hunter } from "./api"
import { MACD_PERIODS, hunterCycleLabel, reboundLongEntry, reboundShortEntry, REBOUND_VERSION, type MacdPeriod } from "./macd-ma20"
import { useHunterStore } from "@/stores/hunter"
import { useAITradingStore } from "@/stores/ai-trading"

export async function scanMacdHunter(group: Hunter, abort: AbortSignal): Promise<void> {
  if (group.config.strategy_version !== REBOUND_VERSION || group.config.scan_location === "server" || abort.aborted) return
  const progress = (text: string) => { if (!abort.aborted) useHunterStore.getState().setProgress(group.id, text) }
  if (group.blocks.length) { progress(group.blocks.join("；")); return }
  const active = group.opportunities.filter(o=>!o.finished_at)
  if (active.length >= group.config.max_positions) { progress("持仓任务数量已满，继续管理现有持仓"); return }
  const directions = group.config.direction === "both" ? ["long", "short"] as const
    : group.config.direction === "short" ? ["short"] as const : ["long"] as const
  const threshold = (group.config.rebound_threshold_pct ?? 10)/100
  const rows = await hunterApi.universe(group.id, abort)
  const periods = group.config.cycles.filter((x): x is MacdPeriod=>x in MACD_PERIODS)
  const planned = rows.length*periods.length
  let found = 0, failures = 0, rejection = "", inspected = 0
  for (const period of periods) {
    for (const quote of rows) {
      const current = useHunterStore.getState().groups.find(g=>g.id === group.id)
      if (abort.aborted || current?.status !== "running" || current.config.scan_location === "server") return
      if (active.some(o=>o.symbol === quote.symbol)) continue
      progress(`${hunterCycleLabel(period)} (${inspected+1}/${planned}) 扫描 ${quote.symbol.toUpperCase()} · 反弹猎手`)
      try {
        // Both directions share one candle snapshot, counted once per symbol/period.
        const data = await hunterApi.data(group.id, quote.symbol, period, abort)
        inspected++
        for (const direction of directions) {
          if (abort.aborted) return
          const signal = direction === "short"
            ? reboundShortEntry(data.bars[period] ?? [], period, Date.now()/1000, threshold)
            : reboundLongEntry(data.bars[period] ?? [], period, Date.now()/1000, threshold)
          if (!signal) continue
          found++
          const mounted = await hunterApi.mount(group.id, { symbol: quote.symbol, cycle: period,
            direction, signal_at: Math.floor(signal.signal_at), entry_kind: "rebound" }, abort)
          if (abort.aborted) return
          await useHunterStore.getState().refresh(abort)
          await useAITradingStore.getState().loadTasks({ silent: true })
          if (mounted.skipped) { rejection = mounted.reason ?? "冷静期中"; continue }
          progress(`${quote.symbol.toUpperCase()} ${hunterCycleLabel(period)}${direction === "short" ? "做空" : "做多"}反弹机会已挂载，服务器按仓位管理执行`)
          return
        }
      } catch (e) {
        if (abort.aborted) return
        failures++
        rejection = e instanceof Error ? e.message : "行情或挂载失败"
      }
    }
  }
  progress(`本轮完成：检查 ${inspected}/${planned} 个币种/周期组合（币池 ${rows.length}），${found} 个新信号，${failures} 次读取或挂载失败。${rejection || "等待新的急跌反弹或实际冲高回落，旧信号不追价。"}`)
}
