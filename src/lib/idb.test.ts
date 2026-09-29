/**
 * IndexedDB 公共入口单测(M1 验收:DB 升到 v2 后旧 K 线缓存仍可读)
 *
 * 用 fake-indexeddb 的独立 IDBFactory 隔离每个用例;先手工以 v1 建库
 * 写入旧数据,再走 @/lib/idb 的 v2 入口,验证升级路径不破坏旧 store。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal("indexedDB", new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 模拟旧版本用户:以 DB v1 建库并写入一条 kline-history 缓存 */
function openV1AndSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ai-trading-desktop", 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore("kline-history", { keyPath: "key" })
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction("kline-history", "readwrite")
      tx.objectStore("kline-history").put({
        key: "rb2610:1d",
        symbol: "rb2610",
        period: "1d",
        bars: [{ time: "2020-01-06T00:00:00", open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        hasMore: false,
        savedAt: 1,
      })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

describe("idb 公共入口", () => {
  it("v1→v5 升级:旧 kline-history 记录仍可读,新增 mining-bars/mining-tasks/volume-profile store", async () => {
    await openV1AndSeed()

    const {
      openDb,
      DB_VERSION,
      MINING_BARS_STORE,
      MINING_TASKS_STORE,
      VOLUME_PROFILE_STORE,
    } = await import("@/lib/idb")
    const db = await openDb()
    expect(db).not.toBeNull()
    expect(db!.version).toBe(5)
    expect(db!.version).toBe(DB_VERSION)
    expect(db!.objectStoreNames.contains("kline-history")).toBe(true)
    expect(db!.objectStoreNames.contains(MINING_BARS_STORE)).toBe(true)
    expect(db!.objectStoreNames.contains(MINING_TASKS_STORE)).toBe(true)
    expect(db!.objectStoreNames.contains(VOLUME_PROFILE_STORE)).toBe(true)

    // 旧记录裸读可读
    const raw = await new Promise<{ bars: unknown[] }>((resolve, reject) => {
      const r = db!.transaction("kline-history", "readonly").objectStore("kline-history").get("rb2610:1d")
      r.onsuccess = () => resolve(r.result as { bars: unknown[] })
      r.onerror = () => reject(r.error)
    })
    expect(raw.bars.length).toBe(1)

    // 走 kline-cache 的读路径(用户实际依赖的函数)同样可读
    const { readKlineCache } = await import("@/lib/kline-cache")
    const entry = await readKlineCache("rb2610", "1d")
    expect(entry).not.toBeNull()
    expect(entry!.bars[0].time).toBe("2020-01-06T00:00:00")
  })

  it("全新环境直接以 v5 建库,已有 store 齐备", async () => {
    const {
      openDb,
      MINING_BARS_STORE,
      MINING_TASKS_STORE,
      VOLUME_PROFILE_STORE,
    } = await import("@/lib/idb")
    const db = await openDb()
    expect(db!.version).toBe(5)
    expect(db!.objectStoreNames.contains("kline-history")).toBe(true)
    expect(db!.objectStoreNames.contains(MINING_BARS_STORE)).toBe(true)
    expect(db!.objectStoreNames.contains(MINING_TASKS_STORE)).toBe(true)
    expect(db!.objectStoreNames.contains(VOLUME_PROFILE_STORE)).toBe(true)
  })
})
