import { hunterApi, type Hunter, type HunterData } from "./api"
import { CYCLES, findSignal, trend, validateLeverage, type Direction } from "./rules"
import { useHunterStore } from "@/stores/hunter"
import { useAuthStore } from "@/stores/auth"
import { useAITradingStore } from "@/stores/ai-trading"

let stopRuntime: (() => void) | null = null

export async function scanHunter(group: Hunter, abort: AbortSignal): Promise<void> {
  const started = Date.now(), summaries: string[] = []
  const progress = (text: string) => { if (!abort.aborted) useHunterStore.getState().setProgress(group.id, text) }
  if (group.config.venue !== "okx") { progress("多周期猎手行情仅支持 OKX，已停止新机会搜索"); return }
  const active = group.opportunities.filter(o => !o.finished_at)
  if (active.length >= group.config.max_positions) { progress("持仓任务数量已满，等待释放预算"); return }
  const ticker = await hunterApi.universe(group.id, abort)
  let rejection = ""
  const directions: Direction[] = group.config.direction === "both" ? ["long", "short"] : ["long"]
  for (const cycle of group.config.cycles) {
    if (abort.aborted) return
    if (group.blocks.some(x => x.includes(cycle))) { progress("该周期处于风控冷却"); continue }
    const c = CYCLES[cycle], candidates: { symbol: string; data: HunterData; relative: number }[] = []
    let cursor = 0, incomplete = false, historyMissing = 0, spreadRejected = 0, failed = 0, trendPassed = 0, signals = 0, dataFailure = ""
    const worker = async () => {
      while (cursor < ticker.length) {
        if (abort.aborted || useHunterStore.getState().groups.find(g => g.id === group.id)?.status !== "running") return
        const q = ticker[cursor++]
        const cap = cycle === "short" ? .0005 : cycle === "medium" ? .001 : .0015
        if (q.spread > cap) { spreadRejected++; continue }
        progress(c.label + "扫描 " + q.symbol.toUpperCase() + "（" + cursor + "/" + ticker.length + "）")
        try {
          const data = await hunterApi.data(group.id, q.symbol, cycle, abort)
          const daily = data.bars["1d"]
          if (!daily?.length || data.now - daily[0][0]/1000 < (cycle === "long" ? 365 : 180) * 86400) { historyMissing++; continue }
          const history = cycle === "short" ? data.bars["1h"] : daily
          const n = cycle === "short" ? 24 : cycle === "medium" ? 7 : 30
          if (!history || history.length <= n) { historyMissing++; continue }
          candidates.push({ symbol: q.symbol, data, relative: history.at(-1)![4] / history.at(-1-n)![4] - 1 })
        } catch (e) {
          if (abort.aborted) return
          incomplete = true
          failed++
          dataFailure = q.symbol.toUpperCase() + "：" + (e instanceof Error ? e.message : "数据不可用")
          progress("行情失败：" + dataFailure)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, ticker.length) }, worker))
    if (incomplete) {
      rejection = c.label + "币池行情不完整，本轮不挂载；" + dataFailure
      summaries.push(c.label + "：币池 " + ticker.length + "，行情失败 " + failed + "，排名未完成")
      continue
    }
    for (const direction of directions) {
      const ranked = [...candidates].sort((a, b) => direction === "long" ? b.relative-a.relative : a.relative-b.relative)
      for (const x of ranked.slice(0, Math.max(1, Math.floor(ranked.length*.2)))) {
        if (abort.aborted || useHunterStore.getState().groups.find(g => g.id === group.id)?.status !== "running") return
        if (active.some(o => o.symbol === x.symbol)) continue
        const { data } = x
        if (!trend(data.bars[c.trend], cycle, direction, data.bars["1w"]) || !trend(data.market, cycle, direction, data.market_week)) continue
        trendPassed++
        const signal = findSignal(data.bars[c.setup], data.bars[c.execution], cycle, direction, Date.now()/1000)
        if (!signal) continue
        signals++
        progress("发现 " + x.symbol.toUpperCase() + " " + c.label + "机会，服务器复核中")
        try {
          validateLeverage(group.config.leverage ?? 1, Math.abs(signal.entry - signal.stop) / signal.entry)
          await hunterApi.mount(group.id, { symbol: x.symbol, cycle, direction, signal_at: Math.floor(signal.signal_at) }, abort)
          if (abort.aborted) return
          await useHunterStore.getState().refresh(abort)
          await useAITradingStore.getState().loadTasks({ silent: true })
          progress("机会已挂载；服务器管理交易，继续寻找下一机会")
          return // Refresh reservations before the next mount.
        } catch (e) {
          if (abort.aborted) return
          rejection = "候选未挂载：" + (e instanceof Error ? e.message : "复核未通过")
          progress(rejection)
        }
      }
    }
    summaries.push(c.label + "：币池 " + ticker.length + "，价差排除 " + spreadRejected + "，历史不足 " + historyMissing + "，历史合格 " + candidates.length + "，排名后趋势通过 " + trendPassed + "，有效信号 " + signals)
  }
  progress((rejection || (ticker.length ? "本轮无合格机会，等待下一轮" : "币池为空，请检查黑白名单及流动性条件")) + "（用时 " + Math.round((Date.now()-started)/1000) + " 秒）\n" + summaries.join("\n"))
}

/** One desktop owner across navigation/windows; logout/mode change aborts work. */
export function startHunterRuntime(): () => void {
  stopRuntime?.()
  const rootAbort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scanAbort: AbortController | undefined
  let releaseLock: (() => void) | undefined
  const next: Record<string, number> = {}
  const iteration = async () => {
    if (rootAbort.signal.aborted) return
    try {
      await useHunterStore.getState().refresh(rootAbort.signal)
      for (const group of useHunterStore.getState().groups) {
        if (rootAbort.signal.aborted) break
        if (group.status !== "running" || (next[group.id] ?? 0) > Date.now()) continue
        scanAbort = new AbortController()
        const cancel = () => scanAbort?.abort()
        rootAbort.signal.addEventListener("abort", cancel, { once: true })
        const unsubscribe = useHunterStore.subscribe(s => {
          if (s.groups.find(g => g.id === group.id)?.status !== "running") cancel()
        })
        try { await scanHunter(group, scanAbort.signal) } finally {
          unsubscribe(); rootAbort.signal.removeEventListener("abort", cancel)
          next[group.id] = Date.now() + group.config.scan_seconds * 1000
        }
      }
    } catch (e) {
      if (!rootAbort.signal.aborted) {
        for (const g of useHunterStore.getState().groups) useHunterStore.getState().setProgress(g.id, e instanceof Error ? e.message : "连接异常，暂停新挂载")
      }
    }
    if (!rootAbort.signal.aborted) timer = setTimeout(() => { void iteration() }, 5000)
  }
  const user = useAuthStore.getState().user
  if (typeof navigator !== "undefined" && navigator.locks && user) {
    // Queue ownership: a surviving window takes over when the owner closes.
    void navigator.locks.request("hunter-scanner:" + user.id + ":" + user.trading_mode, { signal: rootAbort.signal }, async () => {
      if (rootAbort.signal.aborted) return
      const lifetime = new Promise<void>(resolve => { releaseLock = resolve })
      void iteration()
      await lifetime
    }).catch(() => {
      if (!rootAbort.signal.aborted) useHunterStore.setState({ error: "无法获取搜索控制权，暂停新挂载" })
    })
  } else {
    useHunterStore.setState({ error: "当前环境缺少搜索互斥能力，无法安全启动搜索" })
  }
  const stop = () => {
    rootAbort.abort(); scanAbort?.abort()
    if (timer) clearTimeout(timer)
    releaseLock?.()
  }
  stopRuntime = stop
  return stop
}
