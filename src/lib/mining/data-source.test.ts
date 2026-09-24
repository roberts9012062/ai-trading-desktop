/**
 * 本地挖掘数据层单测(M1 验收)
 * - 同一 (symbol,tf,区间) 两次 acquire 返回同一 id,且不重新拉取
 * - bars 严格升序无重复,close<=0 坏 bar 被丢弃
 * - 页数上限截断/区间超限/数据不足 → 抛明确错误,不静默截断
 * - release 递减引用;LRU 超上限只淘汰 refCount=0 的快照,活跃引用跳过
 * - reconcileSnapshotRefs 按活跃任务清单校准泄漏的引用计数
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"

vi.mock("@/lib/kline-channels", () => ({
  getChannelKlineApi: vi.fn(),
  DEFAULT_KLINE_CHANNEL: "binance_spot",
  normalizeChannel: (v: unknown) =>
    v === "okx" || v === "gate_spot" ? (v as string) : "binance_spot",
}))

import { getChannelKlineApi } from "@/lib/kline-channels"
import type { KlineBarApi } from "@/lib/api"

const mockedGet = vi.mocked(getChannelKlineApi)

/** 每个用例全新的 data-source 模块 + 独立 IDB(模块内含可配置上限的单例状态) */
async function loadDataSource() {
  return await import("@/lib/mining/data-source")
}

function bar(time: string, close = 100): KlineBarApi {
  return { time, open: close, high: close, low: close, close, volume: 10, settle: null, open_interest: null }
}

function reply(bars: KlineBarApi[], has_more: boolean) {
  return Promise.resolve({ bars, has_more })
}

function daysOfMonth(year: number, month: number, closeBase = 100): KlineBarApi[] {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return barsBetween(
    `${year}-${String(month).padStart(2, "0")}-01`,
    `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
    closeBase,
  )
}

/** [from, to] 逐日生成 bar(闭区间,跨月正确) */
function barsBetween(fromISO: string, toISO: string, closeBase = 100): KlineBarApi[] {
  const out: KlineBarApi[] = []
  const end = new Date(`${toISO}T00:00:00Z`).getTime()
  for (let ms = new Date(`${fromISO}T00:00:00Z`).getTime(); ms <= end; ms += 86_400_000) {
    const d = new Date(ms).toISOString().slice(0, 10)
    out.push(bar(`${d}T00:00:00`, closeBase + out.length))
  }
  return out
}

const REQ = { symbol: "RB2610", timeframe: "1d", startDate: "2026-01-01", endDate: "2026-01-31" }

beforeEach(() => {
  vi.resetModules()
  mockedGet.mockReset()
  vi.stubGlobal("indexedDB", new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("acquireBarsSnapshot", () => {
  it("同一区间两次 acquire 返回同一 id(内容寻址:数据相同即复用同一快照)", async () => {
    const ds = await loadDataSource()
    mockedGet.mockReturnValue(reply(daysOfMonth(2026, 1), false))

    const s1 = await ds.acquireBarsSnapshot(REQ)
    const s2 = await ds.acquireBarsSnapshot(REQ)

    // id 含内容哈希:同区间同数据 → 同 id。第二次仍会拉取(id 须先算出),
    // 但复用既有记录(refCount 累加),不会落第二条快照
    expect(s2.id).toBe(s1.id)
    expect(s1.count).toBe(31)
    expect(s1.symbol).toBe("rb2610") // 归一化为小写
    expect(s1.from).toBe("2026-01-01")
    expect(s1.to).toBe("2026-01-31")
    expect(s1.sourceHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it("同区间但数据已变(新增 bar)→ 新 id,旧快照独立保留", async () => {
    const ds = await loadDataSource()
    mockedGet.mockReturnValueOnce(reply(daysOfMonth(2026, 1).slice(0, 30), false))
    const s1 = await ds.acquireBarsSnapshot(REQ)

    // 次日服务器多了最后一根 bar → from/to 或哈希变化 → 不同 id
    mockedGet.mockReturnValueOnce(reply(daysOfMonth(2026, 1), false))
    const s2 = await ds.acquireBarsSnapshot(REQ)

    expect(s2.id).not.toBe(s1.id)
    expect(await ds.getBarsSnapshot(s1.id)).not.toBeNull() // 冻结快照不被覆盖
    expect(await ds.getBarsSnapshot(s2.id)).not.toBeNull()
  })

  it("close<=0 的坏 bar 被丢弃,时间严格升序无重复", async () => {
    const ds = await loadDataSource()
    const bars = daysOfMonth(2026, 1)
    bars[10] = bar(bars[10].time, 0) // 坏 bar:close=0
    mockedGet.mockReturnValue(reply(bars, false))

    const s = await ds.acquireBarsSnapshot(REQ)

    expect(s.count).toBe(30)
    const times = s.bars.map((b) => b.time)
    for (let i = 1; i < times.length; i++) expect(times[i - 1] < times[i]).toBe(true)
    expect(s.bars.every((b) => Number(b.close) > 0)).toBe(true)
  })

  it("页数上限截断时抛明确错误,不静默截断", async () => {
    const ds = await loadDataSource()
    // 首页最老一根 01-20 仍晚于 startDate,且 has_more=true → 有更老数据但被页数挡住
    mockedGet.mockReturnValue(reply(daysOfMonth(2026, 1).slice(19), true))

    await expect(ds.acquireBarsSnapshot({ ...REQ, maxPages: 1 })).rejects.toThrow("页上限")
  })

  it("区间跨度超过周期上限时直接报错,不发起拉取", async () => {
    const ds = await loadDataSource()
    // 1d 上限 1825 天;2020-01-01~2026-01-01 ≈ 2192 天
    await expect(
      ds.acquireBarsSnapshot({ ...REQ, startDate: "2020-01-01", endDate: "2026-01-01" }),
    ).rejects.toThrow("上限")
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it("数据不足时抛明确错误", async () => {
    const ds = await loadDataSource()
    mockedGet.mockReturnValue(reply(daysOfMonth(2026, 1).slice(0, 5), false))

    await expect(ds.acquireBarsSnapshot(REQ)).rejects.toThrow("不足")
  })
})

describe("快照引用计数与 LRU 淘汰", () => {
  const BYTES_PER_BAR = 180
  // 三个区间各 30 根(=5400B);上限 10800 恰好容纳两个快照,第三个必然触发淘汰
  const CAP = 30 * BYTES_PER_BAR * 2
  const R1 = { from: "2026-01-01", to: "2026-01-30" }
  const R2 = { from: "2026-03-01", to: "2026-03-30" }
  const R3 = { from: "2026-05-01", to: "2026-05-30" }

  async function prepare() {
    const ds = await loadDataSource()
    ds.configureSnapshotLimits({ maxTotalBytes: CAP })
    return ds
  }

  async function acquireRange(
    ds: Awaited<ReturnType<typeof prepare>>,
    range: { from: string; to: string },
    clockMs: number,
  ) {
    mockedGet.mockReturnValue(reply(barsBetween(range.from, range.to), false))
    vi.setSystemTime(clockMs)
    return await ds.acquireBarsSnapshot({
      symbol: "rb2610",
      timeframe: "1d",
      startDate: range.from,
      endDate: range.to,
    })
  }

  it("release 归零后,超上限时按 fetchedAt LRU 淘汰最旧的未引用快照", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const ds = await prepare()
    const a = await acquireRange(ds, R1, 1000)
    const b = await acquireRange(ds, R2, 2000)
    await ds.releaseBarsSnapshot(a.id)
    await ds.releaseBarsSnapshot(b.id)

    const c = await acquireRange(ds, R3, 3000) // 触发淘汰:最旧的 a 被清,b/c 保留

    expect(await ds.getBarsSnapshot(a.id)).toBeNull()
    expect(await ds.getBarsSnapshot(b.id)).not.toBeNull()
    expect(await ds.getBarsSnapshot(c.id)).not.toBeNull()
  })

  it("被活跃任务引用(refCount>0)的快照不被 LRU 淘汰", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const ds = await prepare()
    const a = await acquireRange(ds, R1, 1000) // 保持引用(模拟活跃任务)
    const b = await acquireRange(ds, R2, 2000)
    await ds.releaseBarsSnapshot(b.id) // 只有 b 归零

    const c = await acquireRange(ds, R3, 3000) // 淘汰只能在 b 里选,a 被跳过

    expect(await ds.getBarsSnapshot(a.id)).not.toBeNull()
    expect(await ds.getBarsSnapshot(b.id)).toBeNull()
    expect(await ds.getBarsSnapshot(c.id)).not.toBeNull()
  })

  it("reconcileSnapshotRefs 按活跃任务清单校准崩溃泄漏的引用计数", async () => {
    const ds = await loadDataSource()
    mockedGet.mockReturnValue(reply(daysOfMonth(2026, 1), false))
    const s = await ds.acquireBarsSnapshot(REQ)
    await ds.acquireBarsSnapshot(REQ) // refCount=2,不 release——模拟崩溃泄漏

    const { openDb, idbGet, MINING_BARS_STORE } = await import("@/lib/idb")
    const db = await openDb()
    const id = s.id

    const before = await idbGet<{ refCount: number }>(db!, MINING_BARS_STORE, id)
    expect(before!.refCount).toBe(2)

    // 无活跃任务 → 归零(此后 LRU 可淘汰)
    await ds.reconcileSnapshotRefs([])
    const zeroed = await idbGet<{ refCount: number }>(db!, MINING_BARS_STORE, id)
    expect(zeroed!.refCount).toBe(0)

    // 出现在活跃清单 → 校准为出现次数
    await ds.reconcileSnapshotRefs([id, id])
    const pinned = await idbGet<{ refCount: number }>(db!, MINING_BARS_STORE, id)
    expect(pinned!.refCount).toBe(2)
  })
})

describe("fnv1a32", () => {
  it("已知向量", async () => {
    const ds = await loadDataSource()
    expect(ds.fnv1a32("")).toBe("811c9dc5")
    expect(ds.fnv1a32("a")).toBe("e40c292c")
    expect(ds.fnv1a32("foobar")).toBe("bf9cf968")
  })
})
