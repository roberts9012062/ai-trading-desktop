import { hunterApi, type Hunter } from "./api"
import { MACD_PERIODS, macdMa20Entry, hunterCycleLabel, type MacdPeriod } from "./macd-ma20"
import { useHunterStore } from "@/stores/hunter"
import { useAITradingStore } from "@/stores/ai-trading"

export async function scanMacdHunter(group: Hunter, abort: AbortSignal): Promise<void> {
  if (group.config.scan_location === "server") return
  const progress = (text: string) => { if (!abort.aborted) useHunterStore.getState().setProgress(group.id, text) }
  if (group.blocks.length) { progress(group.blocks.join("；")); return }
  const active = group.opportunities.filter(o=>!o.finished_at)
  if (active.length >= group.config.max_positions) { progress("持仓任务数量已满，继续管理现有持仓"); return }
  const rows = await hunterApi.universe(group.id, abort)
  let found = 0, failures = 0, rejection = "", inspected = 0
  for (const period of group.config.cycles.filter((x): x is MacdPeriod=>x in MACD_PERIODS)) {
    for (const quote of rows) {
      const current = useHunterStore.getState().groups.find(g=>g.id === group.id)
      if (abort.aborted || current?.status !== "running" || current.config.scan_location === "server") return
      if (active.some(o=>o.symbol === quote.symbol) || quote.spread > .001) continue
      progress(`${hunterCycleLabel(period)}扫描 ${quote.symbol.toUpperCase()} · MACD新金叉 / 连续3–4根实体在MA20上方 / MA20向上`)
      try {
        const data = await hunterApi.data(group.id, quote.symbol, period, abort)
        inspected++
        const signal = macdMa20Entry(data.bars[period] ?? [], period, Date.now()/1000)
        if (!signal) continue
        found++
        const mounted = await hunterApi.mount(group.id, { symbol: quote.symbol, cycle: period,
          direction: "long", signal_at: Math.floor(signal.signal_at), entry_kind: "macd_ma20" }, abort)
        if (abort.aborted) return
        await useHunterStore.getState().refresh(abort)
        await useAITradingStore.getState().loadTasks({ silent: true })
        if (mounted.skipped) { rejection = mounted.reason ?? "冷静期中"; continue }
        progress(`${quote.symbol.toUpperCase()} ${hunterCycleLabel(period)}做多机会已挂载，服务器按仓位管理执行`)
        return
      } catch (e) {
        if (abort.aborted) return
        failures++
        rejection = e instanceof Error ? e.message : "行情或挂载失败"
      }
    }
  }
  progress(`本轮完成：${inspected} 个币种/周期检查，${found} 个新信号，${failures} 次读取或挂载失败。${rejection || "等待下一次新金叉；超过4根站上MA20的行情跳过。"}`)
}
