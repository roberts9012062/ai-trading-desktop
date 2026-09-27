// 研究缓存合并语义:并集、同 time 新拉覆盖(修订自愈)、升序;node 无 IDB 时读路径 fail-open
import { describe, expect, it } from "vitest"
import { mergeBarsPreferNew, readResearchKlines, researchCacheKey } from "./research-kline-cache"
import type { KlineBar } from "@/types"

const bar = (time: string, close: number): KlineBar =>
  ({ time, open: 1, high: 1, low: 1, close, volume: 1 } as KlineBar)

describe("research-kline-cache", () => {
  it("key 规范化:渠道:小写币种:周期", () => {
    expect(researchCacheKey("binance_usdt", " BTCUSDT ", "15m")).toBe("binance_usdt:btcusdt:15m")
  })

  it("合并:并集 + 同 time 以新拉为准(修订自愈) + 升序", () => {
    const base = [bar("2024-01-01 08:00:00", 1), bar("2024-01-01 09:00:00", 2), bar("2024-01-03 08:00:00", 5)]
    const newer = [bar("2024-01-01 09:00:00", 2.5), bar("2024-01-02 08:00:00", 3)]
    const merged = mergeBarsPreferNew(base, newer)
    expect(merged.map((b) => b.time)).toEqual([
      "2024-01-01 08:00:00",
      "2024-01-01 09:00:00",
      "2024-01-02 08:00:00",
      "2024-01-03 08:00:00",
    ])
    expect(merged[1].close).toBe(2.5) // 修订覆盖
    expect(merged[0].close).toBe(1) // 缓存独有保留
  })

  it("合并:空侧直通", () => {
    expect(mergeBarsPreferNew([], [bar("t", 1)])).toHaveLength(1)
    expect(mergeBarsPreferNew([bar("t", 1)], [])).toHaveLength(1)
  })

  it("读缓存:node 无 IndexedDB 时 fail-open 返回 null", async () => {
    expect(await readResearchKlines("binance_spot", "btcusdt", "1d")).toBeNull()
  })
})
