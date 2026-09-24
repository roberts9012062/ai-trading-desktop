"use client"

/**
 * 成交量分布本地采集引擎 —— 全局常驻（由 (main)/layout 挂载启动）
 *
 * 桌面端本地化数据源（替代 web 端远端 REST 基线 + 30s 校准）：
 * - 1s 心跳读 market store 的 orderbook/quote 快照，按口径
 *   （volume-profile-core，同源移植自 web 服务端 trade_tick_svc）
 *   逐品种采集单秒 tick、增量聚合进 volume-profile store；
 * - orderbook.asof 指纹去重：同一秒快照不重复计数；
 * - IndexedDB 按交易日整包持久化（30s 节流），重启/刷新恢复当日；
 * - 跨交易日（北京 21:00 起）自动清桶，只保留当日；
 * - virtual 盘为模拟撮合，口径不符，不采集（与 web 端一致）。
 *
 * 局限（与 web 服务端 scheduler 同级）：WS 快照逐秒推送，心跳错过的
 * 秒无法回补；同品种单秒成交语义由服务端 current_volume 保证。
 */

import {
  idbGet,
  idbGetAll,
  idbPut,
  idbDelete,
  openDb,
  VOLUME_PROFILE_STORE,
} from "@/lib/idb"
import {
  applyTick,
  bjTimestamp,
  collectTick,
  emptyAcc,
  tradingDayOfBj,
  type VolumeProfileAcc,
} from "@/lib/volume-profile-core"
import { useAuthStore } from "@/stores/auth"
import { useMarketStore } from "@/stores/market"
import { useVolumeProfileStore } from "@/stores/volume-profile"

/** 心跳间隔：对齐服务端 scheduler 的逐秒采集节奏 */
const TICK_MS = 1_000
/** IDB 持久化节流间隔 */
const FLUSH_MS = 30_000

/** symbol（原样键）→ 上次已采集的 orderbook.asof（Unix 秒） */
const _lastAsof = new Map<string, number>()

let _timer: ReturnType<typeof setInterval> | null = null
let _lastFlushAt = 0

/** 单次心跳：采集 → 聚合 → 提交 store，返回是否有更新 */
function _heartbeat(): boolean {
  const auth = useAuthStore.getState()
  const mode = auth.user?.trading_mode ?? "live"
  if (mode !== "live") return false

  const store = useVolumeProfileStore.getState()
  const day = tradingDayOfBj(new Date())
  if (store.day !== day) {
    // 跨交易日：清桶开新一天（旧日 blob 由 flush 清理）
    store.resetDay(day)
  }

  const market = useMarketStore.getState()
  const quotes = market.quotes
  const occurredAt = bjTimestamp(new Date())
  const updates: Record<string, VolumeProfileAcc> = {}

  for (const ob of Object.values(market.orderbooks)) {
    if (!ob?.symbol) continue
    // asof 指纹去重：同一秒快照（未更新或回退）不重复采集
    if (typeof ob.asof === "number") {
      const last = _lastAsof.get(ob.symbol)
      if (last !== undefined && ob.asof <= last) continue
      _lastAsof.set(ob.symbol, ob.asof)
    }
    const quote =
      quotes[ob.symbol] ??
      quotes[ob.symbol.toLowerCase()] ??
      quotes[ob.symbol.toUpperCase()]
    const lastPrice = quote ? Number((quote as { last_price?: number | null }).last_price ?? null) : null
    const tick = collectTick(ob, lastPrice, occurredAt)
    if (!tick) continue
    const acc = store.bySymbol[tick.symbol] ?? emptyAcc()
    updates[tick.symbol] = applyTick(acc, tick)
  }

  if (Object.keys(updates).length === 0) return false
  useVolumeProfileStore.getState().applyTicks(updates)
  return true
}

/** 持久化当日整包 + 清理非当日 keys（fail-open：IDB 不可用静默降级） */
async function _flush(): Promise<void> {
  const db = await openDb()
  if (!db) return
  const store = useVolumeProfileStore.getState()
  if (store.day) {
    try {
      await idbPut(db, VOLUME_PROFILE_STORE, {
        key: store.day,
        day: store.day,
        bySymbol: store.bySymbol,
      })
    } catch {
      // 持久化失败不影响内存聚合
    }
  }
  // 只保当日：其余日 keys 一并删除
  try {
    const all = await idbGetAll<{ key: string }>(db, VOLUME_PROFILE_STORE)
    for (const item of all) {
      if (item?.key && item.key !== store.day) {
        await idbDelete(db, VOLUME_PROFILE_STORE, item.key).catch(() => undefined)
      }
    }
  } catch {
    // 清理失败下次再试
  }
}

/** 启动恢复：读回当日整包（无则空桶起步），并清理历史日 keys */
async function _restore(): Promise<void> {
  const day = tradingDayOfBj(new Date())
  const db = await openDb()
  if (!db) {
    useVolumeProfileStore.getState().restore(day, {})
    return
  }
  let bySymbol: Record<string, VolumeProfileAcc> = {}
  try {
    const blob = await idbGet<{ bySymbol: Record<string, VolumeProfileAcc> }>(
      db,
      VOLUME_PROFILE_STORE,
      day,
    )
    if (blob?.bySymbol) bySymbol = blob.bySymbol
  } catch {
    // 读失败走空桶
  }
  useVolumeProfileStore.getState().restore(day, bySymbol)
  void _flush()
}

/**
 * 启动采集引擎（幂等）。返回停止函数（清心跳并落盘一次）。
 * 由 (main)/layout 挂载：useEffect(() => startVolumeProfileEngine(), [])
 */
export function startVolumeProfileEngine(): () => void {
  if (_timer) return () => undefined
  void _restore()
  _timer = setInterval(() => {
    const changed = _heartbeat()
    const now = Date.now()
    if (changed && now - _lastFlushAt >= FLUSH_MS) {
      _lastFlushAt = now
      void _flush()
    }
  }, TICK_MS)
  return () => {
    if (_timer) {
      clearInterval(_timer)
      _timer = null
    }
    _lastAsof.clear()
    _lastFlushAt = 0
    void _flush()
  }
}
