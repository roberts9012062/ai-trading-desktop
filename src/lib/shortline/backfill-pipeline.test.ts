import { describe, expect, it } from "vitest"
import { zipSync } from "fflate"
import { dayZipToDigest, listDays, missingRange, runBackfillWithStore, type BackfillDeps } from "./backfill/pipeline"
import { parseAggTradesCsv, BucketAccumulator } from "./bucket-stream"

function makeDayZip(rows: readonly string[]): Uint8Array {
  const csv = rows.join("\n") + "\n"
  return zipSync({ "x.csv": new TextEncoder().encode(csv) })
}

const CSV_HEADERless = (day: string) => {
  const base = Date.parse(`${day}T00:00:00Z`) / 1000
  return [
    `1,3000.5,1.2,100,100,${(base + 1) * 1000},false`,
    `2,3001.0,0.8,101,101,${(base + 1) * 1000 + 400},true`,
    `3,2999.5,2.0,102,102,${(base + 30) * 1000},false`,
  ]
}

describe("aggTrades 回填管道", () => {
  it("listDays 含首尾", () => {
    expect(listDays("2026-09-28", "2026-09-30")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"])
    expect(listDays("2026-09-30", "2026-09-28")).toEqual([])
  })

  it("dayZipToDigest 聚合与 SHA 确定", () => {
    const zip = makeDayZip(CSV_HEADERless("2026-09-28"))
    const a = dayZipToDigest(zip)
    const b = dayZipToDigest(makeDayZip(CSV_HEADERless("2026-09-28")))
    expect(a.status).toBe("done")
    expect(a.count).toBe(2) // 两秒桶
    expect(a.sha256).toBe(b.sha256)
    expect(a.buckets!.length).toBe(2)
    expect(a.buckets![1]!.takerBuyVol).toBeCloseTo(2.0, 12) // 第二桶 m=true（买方挂单）→ 主动卖
  })

  it("CSV 解析：m=true 为主动卖（takerBuy=0）", () => {
    const acc = new BucketAccumulator()
    parseAggTradesCsv("1,100,1,2,3,1700000000000,true", (r) => acc.pushCsvRow(r))
    expect(acc.list()[0]!.takerBuyVol).toBe(0)
  })

  it("missingRange：增量区间计算（只补缺失/最新）", () => {
    const days = listDays("2026-09-01", "2026-09-05")
    expect(days).toHaveLength(5)
    // 无缓存 → 全量
    const none = missingRange("2026-09-01", "2026-09-05", [])
    expect(none).toEqual({ from: "2026-09-01", to: "2026-09-05", cachedCount: 0, firstGap: "2026-09-01" })
    // 中间+尾部缺失 → from=第一缺口, to=最后缺口
    const partial = missingRange("2026-09-01", "2026-09-05", ["2026-09-01", "2026-09-02", "2026-09-04"])
    expect(partial.from).toBe("2026-09-03")
    expect(partial.to).toBe("2026-09-05")
    expect(partial.cachedCount).toBe(3)
    expect(partial.firstGap).toBe("2026-09-03")
    // 全已缓存 → 无缺口（from/to 收敛到 to）
    const full = missingRange("2026-09-01", "2026-09-05", days)
    expect(full.firstGap).toBeNull()
    expect(full.cachedCount).toBe(5)
    expect(full.from).toBe("2026-09-05")
  })

  it("runBackfillWithStore：外部 signal 中止——已完成日照常入库并标注停止", async () => {
    const zips = new Map<string, Uint8Array>()
    for (const d of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      zips.set(`T2-${d}`, makeDayZip(CSV_HEADERless(d)))
    }
    const controller = new AbortController()
    const saved: string[] = []
    let calls = 0
    const deps: BackfillDeps = {
      fetchZip: async (url, signal) => {
        if (signal?.aborted) throw new DOMException("已停止", "AbortError")
        calls += 1
        if (calls >= 2) controller.abort() // 第二天下载后用户点停止
        const day = url.slice(-14, -4)
        return zips.get(`T2-${day}`) ?? null
      },
      listSavedDays: async () => [],
      saveDay: async (_s, day) => { saved.push(day) },
    }
    const summary = await runBackfillWithStore(
      { symbol: "T2", fromDay: "2026-09-28", toDay: "2026-09-30", signal: controller.signal },
      deps,
    )
    expect(summary.done).toBeGreaterThanOrEqual(1)
    expect(saved).toContain("2026-09-28")
    expect(summary.errors[0]!.error).toContain("已手动停止")
    // 停止后不再继续下载剩余天
    expect(calls).toBeLessThanOrEqual(2)
  })

  it("runBackfillWithStore：断点续传跳过已有、预算超限停止、missing 计数", async () => {
    const zips = new Map<string, Uint8Array>()
    zips.set("TEST-2026-09-28", makeDayZip(CSV_HEADERless("2026-09-28")))
    zips.set("TEST-2026-09-29", makeDayZip(CSV_HEADERless("2026-09-29")))
    // 09-30 缺失（404）
    const saved: string[] = ["2026-09-28"] // 已有（断点续传）
    const deps: BackfillDeps = {
      fetchZip: async (url) => {
        const day = url.slice(-14, -4) // .../TEST-aggTrades-2026-09-29.zip
        const key = `TEST-${day}`
        return zips.get(key) ?? null
      },
      listSavedDays: async () => [...saved],
      saveDay: async (_s, day) => { saved.push(day) },
    }
    const progress: string[] = []
    const summary = await runBackfillWithStore(
      { symbol: "TEST", fromDay: "2026-09-28", toDay: "2026-09-30", onProgress: (p) => progress.push(`${p.day}:${p.status}`) },
      deps,
    )
    expect(summary.skipped).toBe(1)
    expect(summary.done).toBe(1)
    expect(summary.missing).toBe(1)
    expect(saved).toContain("2026-09-29")
    expect(progress).toContain("2026-09-30:missing")

    // 预算超限：budget=1 字节 → 第一天即停止
    const saved2: string[] = []
    const deps2: BackfillDeps = {
      ...deps,
      listSavedDays: async () => [],
      saveDay: async (_s, day) => { saved2.push(day) },
    }
    const s2 = await runBackfillWithStore(
      { symbol: "TEST", fromDay: "2026-09-28", toDay: "2026-09-28", budgetBytes: 1 },
      deps2,
    )
    expect(s2.done).toBe(0)
    expect(s2.errors[0]!.error).toContain("磁盘预算不足")
    expect(saved2.length).toBe(0)
  })
})
