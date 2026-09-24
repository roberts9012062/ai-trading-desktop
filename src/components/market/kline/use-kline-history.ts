"use client"

/**
 * K 线历史加载：缓存优先 + 后台刷新 + 邻合约预取
 */

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react"
import type { IChartApi } from "lightweight-charts"
import { getKlineApi } from "@/lib/api"
import { mergeServerBarsWithLocal, readKlineCache, writeKlineCache } from "@/lib/kline-cache"
import { useMarketStore } from "@/stores/market"
import type { KlineBar, KlinePeriod } from "@/types"

const PAGE_LIMIT = 200
/**
 * 前端「已收盘历史」缓存新鲜度（秒级 UI 不算过期）
 * 注意：当前 forming bar 不靠此缓存，由 WS quote / kline:realtime 每秒覆盖。
 * 超过该时间后后台静默重拉历史（不挡 UI），保证收盘序列完整。
 */
/** 历史缓存 15s 即后台重拉，便于运维清 Redis 后前端尽快对齐 */
const FRONTEND_STALE_MS = 15_000
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

async function fetchAndStore(
  symbol: string,
  period: KlinePeriod,
  force: boolean,
  opts?: { retryEmpty?: boolean }
): Promise<void> {
  if (period === "tick") return
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

  const task = (async () => {
    // 本地 IndexedDB 缓存先画(stale-while-revalidate):命中即整段展示,
    // 网络成功后覆盖并回写;失败/为空保留缓存画面。仅冷启动(内存无数据)时启用
    let cachedHit = false
    if (!existing || existing.length === 0) {
      try {
        const cached = await readKlineCache(symbol, period)
        const cur = useMarketStore.getState().klineBars[symbol]?.[period]
        if (cached && (!cur || cur.length === 0)) {
          useMarketStore.getState().setKlineBars(symbol, period, cached.bars)
          useMarketStore.getState().setKlineHasMore(key, cached.hasMore)
          cachedHit = true
        }
      } catch {
        // 缓存读失败按无缓存处理
      }
    }
    // 无缓存时才亮 loading,有缓存静默刷新不挡 UI
    const showLoading = !cachedHit && (!existing || existing.length === 0)
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
            // 本地优先合并:服务端与本地按时间做并集(同时间以服务端为准),
            // 并按交易轴校验分钟 bar 时间,剔除旧口径存量 bar(双 K 根源)
            const cur = useMarketStore.getState().klineBars[symbol]?.[period] ?? []
            const merged = mergeServerBarsWithLocal(resp.bars as KlineBar[], cur, 2000, symbol, period)
            useMarketStore
              .getState()
              .setKlineBars(symbol, period, merged)
            useMarketStore.getState().setKlineHasMore(key, resp.has_more)
            // 网络成功:合并结果覆盖回写本地缓存
            void writeKlineCache(symbol, period, merged, resp.has_more)
            // 仅非空才记时间：空结果不算「已取」，后续切换回来立即重试
            lastFetchAt.set(key, Date.now())
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
  for (let i = 0; i < n; i++) {
    void worker()
  }
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
    klineBars[props.activeContract]?.[props.period] ?? []
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
          // 翻页合并结果回写本地缓存(取 store 已合并列表)
          const merged = useMarketStore.getState().klineBars[symbol]?.[p]
          if (merged && merged.length > 0) {
            void writeKlineCache(symbol, p, merged, resp.has_more)
          }
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
    void loadHistory(props.activeContract, props.period)
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
