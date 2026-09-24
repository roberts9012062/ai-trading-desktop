/**
 * IndexedDB 公共入口 —— 全应用唯一的 DB 版本升级点
 *
 * DB `ai-trading-desktop` 的 object store 一览:
 *   v1: kline-history  K 线历史缓存(keyPath "key")
 *   v2: mining-bars    本地挖掘 K 线快照(keyPath "id")
 *   v3: mining-tasks   本地挖掘任务持久化(keyPath "id")
 *   v4: volume-profile 成交量分布按交易日整包持久化(keyPath "key"=交易日)
 *
 * 约束:任何模块要新增 store,必须在这里升 DB_VERSION 并在本文件的
 * onupgradeneeded 里创建——不要另开 indexedDB.open("ai-trading-desktop", N):
 * 两个不同版本号的 open 会互相触发 versionchange 阻塞。
 *
 * 打开失败 resolve(null)(与 kline-cache 的 fail-open 约定一致,调用方
 * 自行决定降级行为);IDB 不可用的环境(node 测试/SSR)同样返回 null。
 */

const DB_NAME = "ai-trading-desktop"
export const DB_VERSION = 4

export const KLINE_HISTORY_STORE = "kline-history"
export const MINING_BARS_STORE = "mining-bars"
export const MINING_TASKS_STORE = "mining-tasks"
export const VOLUME_PROFILE_STORE = "volume-profile"

let dbPromise: Promise<IDBDatabase | null> | null = null

export function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(KLINE_HISTORY_STORE)) {
          db.createObjectStore(KLINE_HISTORY_STORE, { keyPath: "key" })
        }
        if (!db.objectStoreNames.contains(MINING_BARS_STORE)) {
          db.createObjectStore(MINING_BARS_STORE, { keyPath: "id" })
        }
        if (!db.objectStoreNames.contains(MINING_TASKS_STORE)) {
          db.createObjectStore(MINING_TASKS_STORE, { keyPath: "id" })
        }
        if (!db.objectStoreNames.contains(VOLUME_PROFILE_STORE)) {
          db.createObjectStore(VOLUME_PROFILE_STORE, { keyPath: "key" })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

// ========== 轻量 promise 封装(挖掘数据层等需要明确失败语义的调用方用;
// kline-cache 维持自身 fail-open 封装,不强制迁移) ==========

export function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error ?? new Error(`IDB 读取失败: ${store}/${key}`))
  })
}

export function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite")
    tx.objectStore(store).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`IDB 写入失败: ${store}`))
  })
}

export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll()
    req.onsuccess = () => resolve((req.result ?? []) as T[])
    req.onerror = () => reject(req.error ?? new Error(`IDB 读取失败: ${store}`))
  })
}

export function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite")
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`IDB 删除失败: ${store}/${key}`))
  })
}
