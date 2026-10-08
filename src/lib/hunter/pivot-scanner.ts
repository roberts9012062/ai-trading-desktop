import { hunterApi, type Hunter } from "./api"
import { PIVOT_VERSION, pivotEntry } from "./pivot"
import { useHunterStore } from "@/stores/hunter"
import { useAITradingStore } from "@/stores/ai-trading"
import type { Direction } from "./rules"

export async function scanPivotHunter(group: Hunter, abort: AbortSignal): Promise<void> {
  if (group.config.strategy_version !== PIVOT_VERSION || group.config.scan_location === "server" || abort.aborted) return
  const fingerprint = JSON.stringify(group.config)
  const current = () => useHunterStore.getState().groups.find(g => g.id === group.id)
  const valid = () => !abort.aborted && current()?.status === "running" && JSON.stringify(current()?.config) === fingerprint
  const progress = (message: string) => { if (valid()) useHunterStore.getState().setProgress(group.id, message) }
  if (!valid()) return
  if (group.blocks.length) { progress(group.blocks.join("；")); return }
  const active = group.opportunities.filter(o => !o.finished_at)
  const slots = Math.min(10, group.config.max_positions)-active.length
  if (slots <= 0) { progress("持仓任务数量已满，继续管理现有持仓"); return }
  const cold = (symbol: string) => {
    const state = current()?.runtime.symbol_cooldowns?.[symbol]
    return Boolean(state?.active || state?.error)
  }
  const directions: Direction[] = group.config.direction === "both" ? ["long", "short"] : [group.config.direction]
  const pool = (await hunterApi.universe(group.id, abort)).slice(0, Math.min(200, group.config.pool_size))
    .filter(q => !active.some(o => o.symbol === q.symbol) && !cold(q.symbol))
  const results: { symbol: string; direction: Direction; signal_at: number }[][] = new Array(pool.length)
  let cursor = 0, scanned = 0, failures = 0, mounted = 0, rejection = ""
  async function worker() {
    while (valid()) {
      const index = cursor++
      if (index >= pool.length) return
      const symbol = pool[index].symbol
      results[index] = []
      try {
        const data = await hunterApi.data(group.id, symbol, "60m", abort)
        if (!valid()) return
        scanned++
        progress(`60分钟枢轴 · 扫描 ${scanned}/${pool.length} · ${symbol.toUpperCase()}`)
        for (const direction of directions) {
          const signal = pivotEntry(data.bars["60m"] ?? [], Date.now()/1000, group.config.pivot_params, direction)
          if (signal) results[index].push({ symbol, direction, signal_at: signal.signal_at })
        }
      } catch (error) {
        if (!valid()) return
        failures++; rejection = error instanceof Error ? error.message : "行情读取失败"
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pool.length) }, worker))
  for (const signal of results.flat().filter(Boolean)) {
    if (!valid() || mounted >= slots) break
    const latest = current()!
    if (latest.blocks.length || latest.opportunities.filter(o => !o.finished_at).length >= Math.min(10, latest.config.max_positions)) break
    if (cold(signal.symbol) || latest.opportunities.some(o => !o.finished_at && o.symbol === signal.symbol)) continue
    try {
      const result = await hunterApi.mount(group.id, { ...signal, cycle: "60m", entry_kind: "swing_pivot" }, abort)
      if (!valid()) return
      if (!result.skipped && !result.duplicate) mounted++
      else rejection = result.reason ?? "已有该信号或处于冷静期"
      await useHunterStore.getState().refresh(abort)
    } catch (error) {
      if (!valid()) return
      failures++; rejection = error instanceof Error ? error.message : "挂载失败"
      if ((error as { status?: number }).status === 403) break
    }
  }
  if (!valid()) return
  if (mounted) await useAITradingStore.getState().loadTasks({ silent: true })
  progress(`60分钟枢轴：扫描 ${scanned}/${pool.length}，本轮挂载 ${mounted} 单（最多同时10单），失败 ${failures} 次。${rejection || "等待最近2根K线内的多空信号。"}`)
}
