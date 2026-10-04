import { hunterApi, type ContextSnapshot, type DeltaBars, type Hunter, type HunterData, type RankingSnapshot, type SnapshotBody } from "./api"
import { BALANCED_VERSION, CYCLES, closedBars, entrySignal, rankFraction, trend, validateLeverage, watchStage, type Bar, type Cycle, type Direction } from "./rules"
import { useHunterStore } from "@/stores/hunter"
import { useAITradingStore } from "@/stores/ai-trading"
import { ADAPTIVE_VERSION } from "./rules"
import { marketAllows } from "./adaptive"

/** Bounded priority for data reads; queued short jobs precede medium/long jobs. */
export class ReadQueue {
  private active = 0
  private jobs: { priority: number; run: () => void }[] = []
  run<T>(cycle: Cycle, signal: AbortSignal, job: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.jobs.push({ priority: cycle === "short" ? 0 : 1, run: () => {
        if (signal.aborted) { reject(new DOMException("搜索已取消", "AbortError")); this.pump(); return }
        this.active++
        void job().then(resolve, reject).finally(() => { this.active--; this.pump() })
      } })
      this.pump()
    })
  }
  private pump() {
    while (this.active < 2 && this.jobs.length) {
      this.jobs.sort((a, b) => a.priority-b.priority)
      this.jobs.shift()!.run()
    }
  }
}

export function mergeDelta(previous: Bar[], delta: DeltaBars, seconds: number, now: number): Bar[] {
  if (!delta || !Array.isArray(delta.rows)) throw new Error("行情增量格式错误")
  if (!delta.reset && (!previous.length || !delta.rows.length || delta.rows[0][0] !== previous.at(-1)![0])) throw new Error("行情增量缺少锚点，等待重建")
  const incoming = closedBars(delta.rows, seconds, now)
  if (incoming.length !== delta.rows.length) throw new Error("行情包含未收盘或无效K线")
  const source = delta.reset ? incoming : [...previous, ...incoming]
  const rows = closedBars(source, seconds, now).slice(-450)
  if (rows.some((b, i) => i > 0 && b[0]-rows[i-1][0] !== seconds*1000)) throw new Error("行情增量存在缺口，等待重建")
  return rows
}

const seconds: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 }
export function mergeContext(previous: HunterData | undefined, item: ContextSnapshot, cycle: Cycle): HunterData {
  if (!Number.isFinite(item.now)) throw new Error("行情时间无效")
  const bars: Record<string, Bar[]> = {}
  for (const [p, update] of Object.entries(item.bars)) bars[p] = mergeDelta(previous?.bars[p] ?? [], update, seconds[p], item.now)
  return { bars, market: mergeDelta(previous?.market ?? [], item.market, seconds[CYCLES[cycle].trend], item.now),
    market_week: mergeDelta(previous?.market_week ?? [], item.market_week, 604800, item.now), now: item.now }
}

export function nextCycleScan(cycle: Cycle, interval: number, started: number, finished: number): number {
  const period = CYCLES[cycle].executionSec*1000, offset = cycle === "long" ? 16*3600000 : 0
  const nextClose = Math.floor((finished-offset)/period)*period+period+offset+2000
  const retry = (cycle === "short" ? interval : Math.max(interval, cycle === "medium" ? 300 : 1800))*1000
  // Measure interval from scan start, and wake after a close regardless of retry delay.
  return Math.max(finished+1000, Math.min(started+retry, nextClose))
}

export class BalancedDiscovery {
  private reads = new ReadQueue()
  private cache = new Map<string, HunterData>()
  private watch = new Map<string, { stage: string; expires: number }>()
  private reports = new Map<Cycle, string>()
  private mounts: Promise<unknown> = Promise.resolve()

  constructor(private groupId: string) {}
  private current(group: Hunter, signal: AbortSignal) {
    const latest = useHunterStore.getState().groups.find(g => g.id === this.groupId)
    return !signal.aborted && latest?.status === "running" && latest.config.strategy_version === group.config.strategy_version && latest.config.pool_size === group.config.pool_size
  }
  private report(cycle: Cycle, message: string, signal: AbortSignal) {
    if (signal.aborted) return
    this.reports.set(cycle, CYCLES[cycle].label+"："+message)
    useHunterStore.getState().setProgress(this.groupId, [...this.reports.values()].join("\n"))
  }
  private async batch<T extends RankingSnapshot | ContextSnapshot>(cycle: Cycle, phase: SnapshotBody["phase"], symbols: string[], signal: AbortSignal): Promise<T[]> {
    const result: T[] = []
    let cursor = 0
    const worker = async () => {
      while (cursor < symbols.length && !signal.aborted) {
        const chunk = symbols.slice(cursor, cursor+8); cursor += 8
        const cursors: Record<string, Record<string, number>> = {}
        if (phase === "context") for (const symbol of chunk) {
          const old = this.cache.get(cycle+":"+symbol)
          if (old) {
            cursors[symbol] = {}
            for (const [p, rows] of Object.entries({ ...old.bars, market: old.market, market_week: old.market_week })) {
              if (rows.length) cursors[symbol][p] = rows.at(-1)![0]
            }
          }
        }
        const response = await this.reads.run(cycle, signal, () => hunterApi.snapshot<T>(this.groupId, { cycle, phase, symbols: chunk, cursors }, signal))
        if (response.items.length !== chunk.length || new Set(response.items.map(i => i.symbol)).size !== chunk.length || response.items.some(i => !chunk.includes(i.symbol))) throw new Error("币池快照不完整")
        result.push(...response.items)
      }
    }
    await Promise.all([worker(), worker()])
    return result
  }

  async scan(group: Hunter, cycle: Cycle, signal: AbortSignal): Promise<void> {
    const started = Date.now()
    const version = group.config.strategy_version ?? BALANCED_VERSION, adaptive = version === ADAPTIVE_VERSION
    const counts: Record<string, number> = {}, signalKeys: string[] = []
    const done = async (message: string) => {
      this.report(cycle, message+"（用时 "+Math.round((Date.now()-started)/1000)+" 秒）", signal)
      if (adaptive && this.current(group, signal)) {
        try { await hunterApi.report(group.id, { cycle, scan_id: crypto.randomUUID(), elapsed: Math.min(3600, (Date.now()-started)/1000), counts, signals: signalKeys.slice(0, 50), note: message.slice(0, 500) }, signal) }
        catch (e) { if (!signal.aborted) this.report(cycle, message+"；扫描统计同步失败："+(e instanceof Error ? e.message : "连接异常"), signal) }
      }
    }
    if (!this.current(group, signal)) return
    // No stale UI watch entries survive an incomplete/currently running scan.
    useHunterStore.getState().setWatch(group.id, cycle, [])
    if (group.blocks.some(b => b.includes(cycle))) { await done("风控冷却中"); return }
    if (group.opportunities.filter(o => !o.finished_at).length >= group.config.max_positions) { await done("持仓任务已满"); return }
    this.report(cycle, "读取币池排名…", signal)
    const ticker = await this.reads.run(cycle, signal, () => hunterApi.universe(group.id, signal))
    if (!this.current(group, signal)) return
    const cap = cycle === "short" ? .0005 : cycle === "medium" ? .001 : .0015
    const pool = ticker.filter(q => q.spread <= cap), spreadRejected = ticker.length-pool.length
    counts.pool = pool.length
    if (!pool.length) { await done("币池为空或价差不合格"); return }
    const ranks = await this.batch<RankingSnapshot>(cycle, "ranking", pool.map(q => q.symbol), signal)
    if (!this.current(group, signal)) return
    const failures = ranks.filter(r => r.error)
    counts.failed = failures.length
    if (failures.length && (!adaptive || failures.length > pool.length*.2)) { await done("排名未完成，行情失败 "+failures.length+"；"+failures[0].symbol.toUpperCase()+"："+failures[0].error); return }
    if (ranks.some(r => r.history_ok && (r.relative === null || !Number.isFinite(r.relative)))) throw new Error("排名行情无效")
    const eligible = ranks.filter(r => !r.error && r.history_ok), directions: Direction[] = group.config.direction === "both" ? ["long", "short"] : ["long"]
    const candidates = directions.flatMap(direction => [...eligible].sort((a, b) => direction === "long" ? b.relative!-a.relative! || a.symbol.localeCompare(b.symbol) : a.relative!-b.relative! || a.symbol.localeCompare(b.symbol))
      .slice(0, Math.max(1, Math.floor(eligible.length*rankFraction(version, cycle)))).map(r => ({ symbol: r.symbol, direction })))
      .filter(r => !group.opportunities.some(o => !o.finished_at && o.symbol === r.symbol))
    const allowed = new Set(candidates.map(x => cycle+":"+x.symbol+":"+x.direction))
    for (const [key, entry] of this.watch) if (key.startsWith(cycle+":") && (!allowed.has(key) || entry.expires < Date.now()/1000)) this.watch.delete(key)
    const allowedSymbols = new Set(pool.map(x => cycle+":"+x.symbol))
    for (const key of this.cache.keys()) if (key.startsWith(cycle+":") && !allowedSymbols.has(key)) this.cache.delete(key)
    candidates.sort((a, b) => Number(this.watch.has(cycle+":"+b.symbol+":"+b.direction))-Number(this.watch.has(cycle+":"+a.symbol+":"+a.direction)))
    this.report(cycle, "排名合格 "+candidates.length+"，更新候选入场数据…", signal)
    const symbols = [...new Set(candidates.map(r => r.symbol))]
    const contexts = symbols.length ? await this.batch<ContextSnapshot>(cycle, "context", symbols, signal) : []
    if (!this.current(group, signal)) return
    let failed = failures.length, trendPassed = 0, found = 0, mounted = 0, rejection = "", waiting = 0, pullbacks = 0, ownRejected = 0, marketRejected = 0, leverageRejected = 0
    const discard = (symbol: string) => {
      this.cache.delete(cycle+":"+symbol)
      for (const key of this.watch.keys()) if (key.startsWith(cycle+":"+symbol+":")) this.watch.delete(key)
    }
    for (const item of contexts) {
      if (item.error) { failed++; rejection = item.symbol.toUpperCase()+"："+item.error; discard(item.symbol); continue }
      try { this.cache.set(cycle+":"+item.symbol, mergeContext(this.cache.get(cycle+":"+item.symbol), item, cycle)) }
      catch (e) { failed++; rejection = e instanceof Error ? e.message : "行情增量失败"; discard(item.symbol) }
    }
    const c = CYCLES[cycle]
    for (const candidate of candidates) {
      if (!this.current(group, signal)) return
      if (contexts.find(i => i.symbol === candidate.symbol)?.error) continue
      const key = cycle+":"+candidate.symbol, data = this.cache.get(key), watchKey = key+":"+candidate.direction
      if (!data) continue
      if (!trend(data.bars[c.trend], cycle, candidate.direction, data.bars["1w"])) { ownRejected++; this.watch.delete(watchKey); continue }
      if (!marketAllows(data.market, cycle, candidate.direction, data.market_week, version)) { marketRejected++; this.watch.delete(watchKey); continue }
      trendPassed++
      const at = Date.now()/1000
      this.watch.set(watchKey, watchStage(data.bars[c.setup], data.bars[c.execution], cycle, candidate.direction, at))
      const entry = entrySignal(data.bars[c.setup], data.bars[c.execution], cycle, candidate.direction, at, version)
      if (!entry) continue
      found++
      signalKeys.push(candidate.symbol+":"+candidate.direction+":"+Math.floor(entry.signal_at))
      try {
        try { validateLeverage(group.config.leverage ?? 1, Math.abs(entry.entry-entry.stop)/entry.entry) }
        catch (e) { leverageRejected++; throw e }
        const mount = this.mounts.catch(() => {}).then(async () => {
          if (!this.current(group, signal)) return false
          // Other cycles may have mounted while this candidate waited.
          await useHunterStore.getState().refresh(signal)
          const latest = useHunterStore.getState().groups.find(g => g.id === group.id)
          if (!this.current(group, signal) || !latest || latest.opportunities.filter(o => !o.finished_at).length >= latest.config.max_positions || latest.opportunities.some(o => !o.finished_at && o.symbol === candidate.symbol)) return false
          if (Date.now()/1000 > entry.expires_at) throw new Error("候选等待期间已过期")
          const result = await hunterApi.mount(group.id, { symbol: candidate.symbol, cycle, direction: candidate.direction, signal_at: Math.floor(entry.signal_at), entry_kind: entry.entry_kind }, signal)
          // Reconcile reservations even if the group was stopped during the request.
          if (!signal.aborted) { await useHunterStore.getState().refresh(signal); await useAITradingStore.getState().loadTasks({ silent: true }) }
          if (result.skipped) { rejection = result.reason ?? "锁利冷却中"; return false }
          if (result.duplicate) { rejection = "该信号已处理，等待新的收盘信号"; return false }
          return true
        })
        this.mounts = mount
        if (await mount) { mounted++; this.watch.delete(watchKey); break }
      } catch (e) { if (signal.aborted) return; rejection = e instanceof Error ? e.message : "服务器复核失败" }
    }
    for (const [key, entry] of this.watch) if (key.startsWith(cycle+":")) { if (entry.stage === "趋势回调观察") pullbacks++; else waiting++ }
    if (this.current(group, signal)) useHunterStore.getState().setWatch(group.id, cycle,
      [...this.watch].filter(([key]) => key.startsWith(cycle+":")).map(([key, entry]) => {
        const [, symbol, direction] = key.split(":")
        return { symbol, direction: direction as Direction, cycle, ...entry }
      }))
    Object.assign(counts, { eligible: eligible.length, candidates: candidates.length, trend: candidates.length-ownRejected, market: trendPassed, found, mounted, failed, leverage: leverageRejected })
    await done("币池 "+ticker.length+"，价差排除 "+spreadRejected+"，历史不足 "+(ranks.length-eligible.length-failures.length)+"，排名候选 "+candidates.length+"，自身趋势排除 "+ownRejected+"，大盘排除 "+marketRejected+"，趋势通过 "+trendPassed+"，突破观察 "+waiting+"，回调观察 "+pullbacks+"，规则信号 "+found+"，已挂载 "+mounted+(leverageRejected ? "，杠杆风险排除 "+leverageRejected : "")+(failed ? "，行情失败 "+failed : "")+(rejection ? "；"+rejection : "；等待下一次收盘或复查"))
  }
}
