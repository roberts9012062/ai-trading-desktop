import type { KlineBar } from "@/types"

export type IntradayPoint = { time: number; value: number }
const OFFSET = 8 * 3600
export const intradayDayStart = (now: number): number => Math.floor((now + OFFSET) / 86400) * 86400 - OFFSET

export function mergeIntraday(points: IntradayPoint[], updates: IntradayPoint[], now: number): IntradayPoint[] {
  const start = intradayDayStart(now), end = start + 86400
  const map = new Map<number, IntradayPoint>()
  for (const p of [...points, ...updates]) {
    const time = Math.floor(p.time / 60) * 60
    if (Number.isFinite(time) && Number.isFinite(p.value) && p.value > 0 && time >= start && time < end && time <= now) {
      map.set(time, { time, value: p.value })
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time)
}

/** Native OKX minute closes, bounded to the current Beijing calendar day. */
export async function loadIntradayHistory(
  fetchPage: (options: { limit: number; endTime?: string }) => Promise<{ bars: KlineBar[]; has_more: boolean }>,
  now: number,
): Promise<{ points: IntradayPoint[]; complete: boolean }> {
  let points: IntradayPoint[] = [], endTime: string | undefined
  const start = intradayDayStart(now)
  for (let page = 0; page < 16; page++) {
    let response
    try { response = await fetchPage({ limit: endTime ? 100 : 300, endTime }) }
    catch (error) { if (!points.length) throw error; return { points, complete: false } }
    const bars = response.bars.filter(b => b.market_source === "okx")
    const parsed = bars.map(b => ({ time: Math.floor(Date.parse(b.time.replace(" ", "T") + "+08:00") / 1000), value: b.close }))
    points = mergeIntraday(points, parsed, now)
    const oldest = bars.reduce<KlineBar | undefined>((a, b) => !a || b.time < a.time ? b : a, undefined)
    if (!oldest) return { points, complete: !response.has_more }
    const earliest = Math.min(...parsed.map(p => p.time))
    if (earliest <= start || !response.has_more) return { points, complete: true }
    if (endTime && oldest.time >= endTime) return { points, complete: false }
    endTime = oldest.time
  }
  return { points, complete: false }
}
