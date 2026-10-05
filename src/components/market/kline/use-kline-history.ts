"use client"

/**
 * K 线历史加载：缓存优先 + 多周期打包一次拉全 + 本地持久化 + 邻合约预取
 *
 * 分时切换秒开的三个支柱：
 * 1. 已收盘历史缓存命中即渲染、零请求（过期阈值放宽见 FRONTEND_STALE_MS）
 * 2. 分钟周期首开走 bundle 端点一次拉全五周期（见 BUNDLE_* 常量）
 * 3. 已收盘历史持久化 localStorage，刷新页面后同样秒切（见 STORAGE_* 常量）
 */

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react"
import type { IChartApi } from "lightweight-charts"
import { getKlineApi, getKlineBundleApi } from "@/lib/api"
// 在线图表轮询服务器共享 OKX 永续快照，本地研究使用独立历史下载链路。
import "@/lib/okx-forming"
import { useMarketStore } from "@/stores/market"
import type { KlineBar, KlinePeriod } from "@/types"

const PAGE_LIMIT = 240
const EMPTY_BARS: KlineBar[] = []
/**
 * 前端「已收盘历史」缓存新鲜度：仅决定「是否发后台静默校验」，缓存
 * 存在时从不阻塞渲染。形成中 bar 由 OKX 轮询更新，WS 重连另有
 * 强制刷新兜底——历史校验放宽到 5 分钟足够安全；切换周期因此零请求。
 */
const FRONTEND_STALE_MS = 5 * 60 * 1000
/** 预取并发上限 */
const PREFETCH_CONCURRENCY = 2
/**
 * 空数据重试（延长等待）：切品种首屏拉不到最新 K 线时，后端会返回空
 * （绝不拿离线库旧 K 线兜底，避免 AI 看到过期行情误判）。前端在窗口内
 * 保持 loading 并按间隔重试，等实时源恢复；超窗后放弃，展示空图。
 */
const EMPTY_RETRY_DELAY_MS = 5_000
const EMPTY_RETRY_WINDOW_MS = 90_000

/** symbol:period → 上次成功拉取时间 */
const lastFetchAt = new Map<string, number>()
/** 进行中的请求，避免重复打后端 */
const inflight = new Map<string, Promise<void>>()

function cacheKey(symbol: string, period: string): string {
  return `${symbol}:${period}`
}

// ===== 多周期打包：分钟周期一次拉全 =====

/** bundle 覆盖的分钟周期（与后端 BUNDLE_PERIODS 一致） */
const BUNDLE_PERIODS: KlinePeriod[] = ["1m", "5m", "15m", "30m", "60m"]
/** 打包成功冷却：与后端分钟历史 Redis TTL（交易时段 10 分钟）对齐 */
const BUNDLE_COOLDOWN_MS = 10 * 60 * 1000
/** 打包失败冷却：避免后端不可达时反复打（单周期路径会接管重试） */
const BUNDLE_FAIL_COOLDOWN_MS = 60_000

/** symbol → 上次 bundle 成功时间 / 上次 bundle 失败时间 */
const _bundleOkAt = new Map<string, number>()
const _bundleFailAt = new Map<string, number>()
/** symbol → 进行中的 bundle 请求 */
const _bundleInflight = new Map<string, Promise<boolean>>()

function bundleGateOpen(symbol: string): boolean {
  const now = Date.now()
  if (now - (_bundleOkAt.get(symbol) ?? 0) < BUNDLE_COOLDOWN_MS) return false
  if (now - (_bundleFailAt.get(symbol) ?? 0) < BUNDLE_FAIL_COOLDOWN_MS) {
    return false
  }
  return true
}

/**
 * bundle 拉全五周期并入库。返回「目标周期是否拿到数据」——bundle 可能
 * 部分周期空（后端单周期异常归一为空），调用方据此决定是否回退单周期。
 */
async function fetchBundleAndStore(
  symbol: string,
  wanted: KlinePeriod
): Promise<boolean> {
  const resp = await getKlineBundleApi(symbol, PAGE_LIMIT)
  let wantedGot = false
  let anyGot = false
  for (const seg of resp.periods) {
    if (!BUNDLE_PERIODS.includes(seg.period as KlinePeriod)) continue
    const p = seg.period as KlinePeriod
    if (seg.bars.length > 0) {
      // 空周期不覆盖已有缓存（可能是部分源故障，保留旧序列 + WS forming）
      useMarketStore
        .getState()
        .setKlineBars(symbol, p, seg.bars as KlineBar[])
      lastFetchAt.set(cacheKey(symbol, p), Date.now())
      anyGot = true
      if (p === wanted) wantedGot = true
    }
    useMarketStore
      .getState()
      .setKlineHasMore(cacheKey(symbol, p), seg.has_more)
  }
  if (anyGot) {
    _bundleOkAt.set(symbol, Date.now())
    schedulePersist()
  }
  return wantedGot
}

/** 触发 bundle（按 symbol 去重合并并发请求） */
function bundleOnce(symbol: string, wanted: KlinePeriod): Promise<boolean> {
  const pending = _bundleInflight.get(symbol)
  if (pending) return pending
  const task = fetchBundleAndStore(symbol, wanted)
    .catch(() => {
      _bundleFailAt.set(symbol, Date.now())
      return false
    })
    .finally(() => {
      _bundleInflight.delete(symbol)
    })
  _bundleInflight.set(symbol, task)
  return task
}

// ===== localStorage 持久化：刷新页面后切分时同样秒切 =====

const STORAGE_KEY = "qihuo.kline-history.okx-swap.v2"
/** 最多持久化合约数（按最近更新时间 LRU 淘汰） */
const STORAGE_MAX_SYMBOLS = 6
/** 每周期持久化根数（首页 240 + 余量） */
const STORAGE_BARS_PER_PERIOD = 260

interface StoredSymbolEntry {
  fetchedAt: number
  periods: Partial<Record<KlinePeriod, KlineBar[]>>
}
type StoredCache = Record<string, StoredSymbolEntry>

let _storageLoaded = false
let _storageSaveTimer: ReturnType<typeof setTimeout> | null = null

/** 懒加载回灌持久化缓存（仅补内存中不存在的 key，不覆盖更新的数据） */
function loadPersistedCache(): void {
  if (_storageLoaded || typeof window === "undefined") return
  _storageLoaded = true
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as StoredCache
    for (const [sym, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry.fetchedAt !== "number" || !entry.periods) {
        continue
      }
      for (const p of BUNDLE_PERIODS) {
        const bars = entry.periods[p]
        if (!Array.isArray(bars) || bars.length === 0) continue
        const key = cacheKey(sym, p)
        if (useMarketStore.getState().klineBars[sym]?.[p]?.length) continue
        if (lastFetchAt.has(key)) continue
        useMarketStore.getState().setKlineBars(sym, p, bars)
        // 记录持久化时的拉取时间：过期则照常触发后台静默校验
        lastFetchAt.set(key, entry.fetchedAt)
      }
    }
  } catch {
    // 损坏数据静默丢弃
  }
}

/** 防抖合并写持久化；配额满等失败静默清空，不影响内存主流程 */
function schedulePersist(): void {
  if (typeof window === "undefined") return
  if (_storageSaveTimer) clearTimeout(_storageSaveTimer)
  _storageSaveTimer = setTimeout(() => {
    _storageSaveTimer = null
    try {
      const state = useMarketStore.getState()
      const candidates: { sym: string; at: number }[] = []
      const entries = new Map<string, StoredSymbolEntry>()
      for (const sym of Object.keys(state.klineBars)) {
        const periodsOut: Partial<Record<KlinePeriod, KlineBar[]>> = {}
        let at = 0
        for (const p of BUNDLE_PERIODS) {
          const bars = state.klineBars[sym]?.[p]
          if (bars && bars.length > 0) {
            periodsOut[p] = bars.slice(-STORAGE_BARS_PER_PERIOD)
            at = Math.max(at, lastFetchAt.get(cacheKey(sym, p)) ?? 0)
          }
        }
        if (at > 0 && Object.keys(periodsOut).length > 0) {
          candidates.push({ sym, at })
          entries.set(sym, { fetchedAt: at, periods: periodsOut })
        }
      }
      candidates.sort((a, b) => b.at - a.at)
      const out: StoredCache = {}
      for (const c of candidates.slice(0, STORAGE_MAX_SYMBOLS)) {
        const e = entries.get(c.sym)
        if (e) out[c.sym] = e
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
    } catch {
      try {
        window.localStorage.removeItem(STORAGE_KEY)
      } catch {
        // noop
      }
    }
  }, 2_000)
}

async function fetchAndStore(
  symbol: string,
  period: KlinePeriod,
  force: boolean,
  opts?: { retryEmpty?: boolean }
): Promise<void> {
  if (period === "tick") return
  loadPersistedCache()
  const key = cacheKey(symbol, period)
  const state = useMarketStore.getState()
  const existing = state.klineBars[symbol]?.[period]
  const fetchedAt = lastFetchAt.get(key) ?? 0
  const fresh = Date.now() - fetchedAt < FRONTEND_STALE_MS

  // 有新鲜缓存且非强制 → 跳过
  if (existing && existing.length > 0 && fresh && !force) {
    return
  }

  const pending = inflight.get(key)
  if (pending) {
    await pending
    return
  }

  // 分钟周期 + 冷却外 + 非强刷：bundle 一次拉全五周期（首开/到期对齐）
  // force（WS 重连强刷）走单周期路径：只校验当前周期，不打全量包
  if (!force && BUNDLE_PERIODS.includes(period) && bundleGateOpen(symbol)) {
    const showLoading = !existing || existing.length === 0
    if (showLoading) state.setKlineLoading(key, true)
    try {
      const wantedGot = await bundleOnce(symbol, period)
      if (wantedGot) return
      // 目标周期空（bundle 部分失败）→ 落到单周期路径走重试语义
    } finally {
      if (showLoading) useMarketStore.getState().setKlineLoading(key, false)
    }
  }

  const task = (async () => {
    // 无缓存时才亮 loading，有缓存静默刷新不挡 UI
    const showLoading = !existing || existing.length === 0
    if (showLoading) state.setKlineLoading(key, true)
    // 首屏无数据时在窗口内重试：后端对最新视图只回新鲜数据（可能为空），
    // 这里延长等待直到拉到 K 线或超窗，不用旧数据兜底画图
    const retryEmpty = opts?.retryEmpty !== false && showLoading
    const deadline = Date.now() + EMPTY_RETRY_WINDOW_MS
    try {
      for (;;) {
        let gotBars = false
        try {
          const resp = await getKlineApi(symbol, period, { limit: PAGE_LIMIT })
          gotBars = resp.bars.length > 0
          if (gotBars) {
            useMarketStore
              .getState()
              .setKlineBars(symbol, period, resp.bars as KlineBar[])
            useMarketStore.getState().setKlineHasMore(key, resp.has_more)
            // 仅非空才记时间：空结果不算「已取」，后续切换回来立即重试
            lastFetchAt.set(key, Date.now())
            schedulePersist()
          }
        } catch (err) {
          console.error("K 线历史数据加载失败:", err)
        }
        if (gotBars) return
        if (!retryEmpty || Date.now() + EMPTY_RETRY_DELAY_MS > deadline) {
          // 超窗放弃：无旧数据时清空（保持原语义，避免残留半截状态）
          if (!useMarketStore.getState().klineBars[symbol]?.[period]?.length) {
            useMarketStore.getState().setKlineBars(symbol, period, [])
          }
          return
        }
        await new Promise((resolve) => setTimeout(resolve, EMPTY_RETRY_DELAY_MS))
      }
    } finally {
      if (showLoading) useMarketStore.getState().setKlineLoading(key, false)
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  await task
}

/**
 * 单周期 force 重拉（公开出口）：实时尾段缺口自愈用。
 * force=true 走单周期路径不打全量包；不做空数据重试循环（缺口场景
 * 后端通常有已收盘数据，空结果留给正常加载路径处理）。
 */
export function forceRefetchKline(symbol: string, period: KlinePeriod): void {
  if (!symbol || period === "tick") return
  void fetchAndStore(symbol, period, true, { retryEmpty: false }).catch(() => {
    // 自愈失败静默：缺口签名仍在时 30s 后由检测侧重试
  })
}

/** 预取若干合约当前周期（空闲时调用，失败忽略） */
export function prefetchKlineHistory(
  symbols: string[],
  period: KlinePeriod
): void {
  if (period === "tick" || symbols.length === 0) return
  const queue = symbols
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      const key = cacheKey(s, period)
      const bars = useMarketStore.getState().klineBars[s]?.[period]
      const fetchedAt = lastFetchAt.get(key) ?? 0
      return !(bars && bars.length > 0 && Date.now() - fetchedAt < FRONTEND_STALE_MS)
    })
  if (queue.length === 0) return

  let idx = 0
  const worker = async () => {
    while (idx < queue.length) {
      const i = idx
      idx += 1
      const sym = queue[i]
      try {
        // 预取失败静默、不重试（后台邻合约，避免重试风暴）
        await fetchAndStore(sym, period, false, { retryEmpty: false })
      } catch {
        // 预取失败静默
      }
    }
  }
  const n = Math.min(PREFETCH_CONCURRENCY, queue.length)
  for (let i = 0; i < n; i += 1) {
    void worker()
  }
}

// ===== 同合约日线预热：分钟周期已由 bundle 覆盖 =====

/** 同一合约预热冷却：与后端日线历史 TTL 对齐 */
const SIBLING_PREFETCH_COOLDOWN_MS = 8 * 60 * 1000

/** 分钟周期（1m~60m）首开由 bundle 一次拉全，预热只剩日线（数据源不同） */
const SIBLING_PERIODS: KlinePeriod[] = ["1d"]

const _siblingPrefetchedAt = new Map<string, number>()

/**
 * 当前周期加载成功后，后台预热同合约日线。
 *
 * 分钟周期不再逐个错峰预热：fetchAndStore 首开即走 bundle 端点一次
 * 拉全五周期（见上方 BUNDLE_*），本函数只补数据链路不同的 1d。
 * 失败静默不重试。
 */
export function prefetchSiblingPeriods(
  symbol: string,
  current: KlinePeriod
): void {
  const sym = symbol.trim()
  if (!sym) return
  const last = _siblingPrefetchedAt.get(sym) ?? 0
  if (Date.now() - last < SIBLING_PREFETCH_COOLDOWN_MS) return
  _siblingPrefetchedAt.set(sym, Date.now())

  SIBLING_PERIODS.filter((p) => p !== current).forEach((p) => {
    const key = cacheKey(sym, p)
    const bars = useMarketStore.getState().klineBars[sym]?.[p]
    const fetchedAt = lastFetchAt.get(key) ?? 0
    if (bars && bars.length > 0 && Date.now() - fetchedAt < SIBLING_PREFETCH_COOLDOWN_MS) {
      return
    }
    void fetchAndStore(sym, p, false, { retryEmpty: false }).catch(() => {
      // 预热失败静默：用户真切换时会按正常路径重拉
    })
  })
}

export function useKlineHistory(props: {
  activeContract: string
  period: KlinePeriod
  mainApiRef: RefObject<IChartApi | null>
  loadingMoreRef: MutableRefObject<boolean>
  lastLoadedEndTimeRef: MutableRefObject<string | null>
  skipScrollRef: MutableRefObject<boolean>
  prevBarsCountRef: MutableRefObject<number>
  savedRangeRef: MutableRefObject<{ from: number; to: number } | null>
  scrollTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
}): {
  loadHistory: (symbol: string, p: KlinePeriod) => Promise<void>
  loadMoreHistory: (symbol: string, p: KlinePeriod) => Promise<void>
  isLoading: boolean
  hasMore: boolean
  currentBars: KlineBar[]
} {
  const {
    klineBars,
    klineLoading,
    klineHasMore,
    prependKlineBars,
    setKlineHasMore,
  } = useMarketStore()

  const currentBars: KlineBar[] =
    klineBars[props.activeContract]?.[props.period] ?? EMPTY_BARS
  const isLoading =
    klineLoading[`${props.activeContract}:${props.period}`] ?? false
  const hasMore =
    klineHasMore?.[`${props.activeContract}:${props.period}`] ?? true

  const loadHistory = useCallback(
    async (symbol: string, p: KlinePeriod) => {
      await fetchAndStore(symbol, p, false)
    },
    []
  )

  // 重连后强制刷新当前合约
  const connectionState = useMarketStore((s) => s.connectionState)
  const prevConnectionStateRef = useRef<string>(connectionState)
  useEffect(() => {
    const prev = prevConnectionStateRef.current
    prevConnectionStateRef.current = connectionState
    if (props.period === "tick") return
    if (prev === "reconnecting" && connectionState === "connected") {
      void fetchAndStore(props.activeContract, props.period, true)
    }
  }, [connectionState, props.activeContract, props.period])

  const loadMoreHistory = useCallback(
    async (symbol: string, p: KlinePeriod) => {
      if (p === "tick" || props.loadingMoreRef.current) return

      const state = useMarketStore.getState()
      const key = `${symbol}:${p}`
      if (!state.klineHasMore[key]) return

      const bars = state.klineBars[symbol]?.[p]
      if (!bars || bars.length === 0) return

      const endTime = bars[0].time
      if (props.lastLoadedEndTimeRef.current === endTime) return

      props.loadingMoreRef.current = true
      props.lastLoadedEndTimeRef.current = endTime
      try {
        const resp = await getKlineApi(symbol, p, {
          limit: PAGE_LIMIT,
          endTime,
        })
        if (resp.bars.length > 0) {
          const chart = props.mainApiRef.current
          if (chart) {
            props.savedRangeRef.current = chart
              .timeScale()
              .getVisibleLogicalRange()
          }
          if (props.scrollTimerRef.current) {
            clearTimeout(props.scrollTimerRef.current)
            props.scrollTimerRef.current = null
          }
          props.skipScrollRef.current = true
          props.prevBarsCountRef.current =
            useMarketStore.getState().klineBars[symbol]?.[p]?.length ?? 0
          prependKlineBars(symbol, p, resp.bars as KlineBar[])
        }
        setKlineHasMore(key, resp.has_more)
      } catch (err) {
        console.error("K 线懒加载失败:", err)
        props.lastLoadedEndTimeRef.current = null
      } finally {
        props.loadingMoreRef.current = false
      }
    },
    [
      prependKlineBars,
      setKlineHasMore,
      props.loadingMoreRef,
      props.lastLoadedEndTimeRef,
      props.mainApiRef,
      props.savedRangeRef,
      props.scrollTimerRef,
      props.skipScrollRef,
      props.prevBarsCountRef,
    ]
  )

  // 切换合约/周期：有缓存先展示，后台按需刷新
  useEffect(() => {
    if (props.period === "tick") return
    void loadHistory(props.activeContract, props.period).then(() => {
      // 首载成功后预热日线（分钟周期已由 bundle 一次拉全），切 1d 首开秒切
      prefetchSiblingPeriods(props.activeContract, props.period)
    })
    // 切合约时重置懒加载游标
    props.lastLoadedEndTimeRef.current = null
  }, [props.activeContract, props.period, loadHistory, props.lastLoadedEndTimeRef])

  return {
    loadHistory,
    loadMoreHistory,
    isLoading,
    hasMore,
    currentBars,
  }
}
