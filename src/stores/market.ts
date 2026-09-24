/**
 * 行情状态管理 —— Zustand store，管理 WebSocket 连接、实时行情、盘口、成交、K 线
 */

import { create } from "zustand"
import type { CodeTreeMap, KlineBar, KlinePeriod, NewsItem, OrderBook, TradeRecord, Message, MessageCategory } from "@/types"
import {
  type QuoteData,
  type WsMessage,
  type ConnectionState,
  getMarketWebSocket,
} from "@/lib/websocket"
import { getContractsByCodeApi, getQuotesSnapshotApi } from "@/lib/api"
import { useNotificationsStore } from "@/stores/notifications"
import { playNotificationSound } from "@/lib/sound"
import { speakBigOrder } from "@/lib/speech"
import { useBigOrderStore, isBigOrderHit, bigOrderColor, type BigOrderDirection } from "@/stores/big-order"
import { useBigOrderToastStore } from "@/stores/big-order-toast"
import { isTaskAlertHit, useTaskAlertStore } from "@/stores/task-alert"
import { useTaskAlertToastStore } from "@/stores/task-alert-toast"
import { useAiMarketStore } from "@/stores/ai-market"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import { speakTaskOrder } from "@/lib/speech"

/**
 * HTTP 拉取行情快照写入 store（侧栏/品种树首屏兜底）
 * 仅填充有 last_price 的条目，避免脏数据覆盖 WS 实时价
 */
async function bootstrapQuotesFromHttp(
  get: () => MarketState,
): Promise<void> {
  try {
    const raw = await getQuotesSnapshotApi()
    if (!Array.isArray(raw) || raw.length === 0) return
    const quotes: QuoteData[] = []
    for (const item of raw) {
      const symbol = String(item.symbol ?? "").trim().toLowerCase()
      const last = Number(item.last_price)
      if (!symbol || !Number.isFinite(last) || last <= 0) continue
      quotes.push({
        symbol,
        name: String(item.name ?? symbol),
        exchange: String(item.exchange ?? ""),
        last_price: last,
        change: Number(item.change) || 0,
        change_pct: Number(item.change_pct) || 0,
        open_price: Number(item.open_price) || 0,
        high_price: Number(item.high_price) || 0,
        low_price: Number(item.low_price) || 0,
        pre_close: Number(item.pre_close) || 0,
        bid_price: Number(item.bid_price) || 0,
        ask_price: Number(item.ask_price) || 0,
        bid_vol: Number(item.bid_vol) || 0,
        ask_vol: Number(item.ask_vol) || 0,
        volume: Number(item.volume) || 0,
        position: Number(item.position) || 0,
        tick_time: String(item.tick_time ?? ""),
        decimal_places: Number(item.decimal_places) || 0,
        source: item.source ? String(item.source) : undefined,
        recv_ts: Number.isFinite(Number(item.recv_ts))
          ? Number(item.recv_ts)
          : undefined,
        trade_date: item.trade_date ? String(item.trade_date) : undefined,
        simnow_stale: Boolean(item.simnow_stale ?? false),
        field_meta:
          item.field_meta && typeof item.field_meta === "object"
            ? (item.field_meta as Record<
                string,
                { source: string; quality: string }
              >)
            : undefined,
      })
    }
    if (quotes.length > 0) {
      get().updateQuotes(quotes)
    }
  } catch {
    // 快照失败不阻断 WS
  }
}

/** 价格变动闪烁方向 */
export type FlashDirection = "up" | "down"

/**
 * 大单命中 → 入库 + 预警（弹窗/语音/提示音）。
 *
 * 两条触发路径共用本函数，确保行为一致：
 * 1. 后端 big_order_tick 事件（市场级显著放量，按 trading_mode 广播）
 * 2. 前端 scanTradesForBigOrder（成交记录命中阈值，与列表高亮同源同口径）
 *
 * 限频：同一 (symbol,direction) 3 秒内只触发一次，避免连续推送刷屏。
 */
const _bigOrderLastFire: Record<string, number> = {}
const BIG_ORDER_FIRE_THROTTLE_MS = 3000

function fireBigOrderAlert(
  symbol: string,
  direction: BigOrderDirection,
  volume: number,
  price: number | null,
): void {
  const settings = useBigOrderStore.getState().settings
  if (!isBigOrderHit(direction, volume, settings)) {
    return
  }

  // 限频
  const now = Date.now()
  const throttleKey = `${symbol}:${direction}`
  const last = _bigOrderLastFire[throttleKey] ?? 0
  if (now - last < BIG_ORDER_FIRE_THROTTLE_MS) {
    return
  }
  _bigOrderLastFire[throttleKey] = now

  const color = bigOrderColor(direction, settings)

  // 弹窗（大单历史由后端 trade_tick 全量落库，前端只负责实时提醒，不再入库）
  if (settings.popup_enabled) {
    useBigOrderToastStore.getState().push({
      symbol,
      direction,
      volume,
      price,
      color,
    })
  }
  // 语音播报
  if (settings.voice_enabled) {
    speakBigOrder({ symbol, direction, volume })
  }
  // 提示音
  if (settings.sound_enabled) {
    playNotificationSound()
  }
}

/**
 * 处理后端推送的大单原始事件（市场级显著放量）。
 * 已命中用户阈值的判定与预警统一交给 fireBigOrderAlert。
 */
async function handleBigOrderTick(raw: Record<string, unknown>): Promise<void> {
  const symbol = String(raw.symbol ?? "").trim().toLowerCase()
  const direction = String(raw.direction ?? "") as BigOrderDirection
  const volume = Number(raw.volume ?? 0)
  const price = raw.price == null ? null : Number(raw.price)
  if (!symbol || (direction !== "buy" && direction !== "sell") || !Number.isFinite(volume) || volume <= 0) {
    return
  }
  fireBigOrderAlert(symbol, direction, volume, price)
}

/**
 * 任务成交流水去重指纹（task:order 唯一，防异常重投刷屏）。
 */
const _seenTaskOrderFps = new Set<string>()
const _SEEN_TASK_FP_LIMIT = 200

/**
 * 处理后端推送的任务下单/平仓事件（task_order_tick，仅本人任务）。
 *
 * 按用户设置过滤（开仓/平仓开关）后触发：弹窗 / 语音 / 提示音；
 * 同时驱动 AI 看盘页选中任务的标记与记录刷新。
 */
function handleTaskOrderTick(raw: Record<string, unknown>): void {
  const taskId = String(raw.task_id ?? "")
  const symbol = String(raw.symbol ?? "").trim().toLowerCase()
  const direction = String(raw.direction ?? "")
  const offset = String(raw.offset ?? "")
  const qty = Number(raw.filled_qty ?? 0)
  const price = raw.price == null ? null : Number(raw.price)
  const orderId = String(raw.order_id ?? "")
  if (
    !taskId ||
    !symbol ||
    (direction !== "buy" && direction !== "sell") ||
    (offset !== "open" && offset !== "close") ||
    !Number.isFinite(qty) ||
    qty <= 0
  ) {
    return
  }

  // AI 看盘页联动：无论预警开关如何，选中任务的标记/记录都刷新
  const aiMarket = useAiMarketStore.getState()
  if (aiMarket.selectedTaskId === taskId) {
    void aiMarket.refreshMarks()
    aiMarket.bumpRecords()
  } else {
    aiMarket.bumpRecords()
  }

  const settings = useTaskAlertStore.getState().settings
  if (!isTaskAlertHit(offset, settings)) return

  // 指纹去重
  const fp = `${taskId}:${orderId || `${symbol}:${raw.time}:${price}:${qty}`}`
  if (_seenTaskOrderFps.has(fp)) return
  _seenTaskOrderFps.add(fp)
  if (_seenTaskOrderFps.size > _SEEN_TASK_FP_LIMIT) {
    const first = _seenTaskOrderFps.values().next().value
    if (first) _seenTaskOrderFps.delete(first)
  }

  // 颜色口径与 K 线标记一致：开多红 / 开空绿 / 平仓橙
  const color =
    offset === "close"
      ? "#f59e0b"
      : direction === "buy"
        ? "#ef4444"
        : "#22c55e"

  if (settings.popup_enabled) {
    useTaskAlertToastStore.getState().push({
      taskId,
      symbol,
      direction: direction as "buy" | "sell",
      offset: offset as "open" | "close",
      price: price != null && Number.isFinite(price) ? price : null,
      qty,
      color,
    })
  }
  if (settings.voice_enabled) {
    speakTaskOrder(
      {
        symbol,
        direction: direction as "buy" | "sell",
        offset: offset as "open" | "close",
        qty,
      },
      settings.voice_enabled,
    )
  }
  if (settings.sound_enabled) {
    playNotificationSound()
  }
}

/**
 * 已处理过的成交记录指纹（避免 updateTrades 整体覆盖导致重复入库）。
 * key = `${symbol}:${time}:${price}:${volume}:${direction}`，集合有上限防膨胀。
 */
const _seenTradeFingerprints = new Set<string>()
const _SEEN_FINGERPRINT_LIMIT = 500

/**
 * 扫描新成交记录，命中用户阈值则触发入库 + 预警。
 *
 * updateTrades 每次整体覆盖某 symbol 的成交列表（后端缓存最近 30 条），
 * 因此用指纹集合去重，确保同一笔成交只处理一次。这是大单历史的主数据源——
 * 与成交列表高亮共用 trade.volume，保证「高亮即入库」口径一致。
 */
function scanTradesForBigOrder(data: Record<string, TradeRecord[]>): void {
  for (const [symbol, records] of Object.entries(data)) {
    if (!Array.isArray(records) || records.length === 0) continue
    const sym = symbol.trim().toLowerCase()
    if (!sym) continue
    for (const trade of records) {
      const dir = trade.direction as BigOrderDirection
      if (dir !== "buy" && dir !== "sell") continue
      const vol = Number(trade.volume ?? 0)
      if (!Number.isFinite(vol) || vol <= 0) continue
      // 先用用户阈值粗筛，避免为每条小额成交都算指纹
      const settings = useBigOrderStore.getState().settings
      if (!isBigOrderHit(dir, vol, settings)) continue

      const fp = `${sym}:${trade.time}:${trade.price}:${vol}:${dir}`
      if (_seenTradeFingerprints.has(fp)) continue
      _seenTradeFingerprints.add(fp)
      // 控制集合大小：超限时丢弃最旧（Set 保持插入序）
      if (_seenTradeFingerprints.size > _SEEN_FINGERPRINT_LIMIT) {
        const first = _seenTradeFingerprints.values().next().value
        if (first) _seenTradeFingerprints.delete(first)
      }

      const price = Number.isFinite(Number(trade.price)) ? Number(trade.price) : null
      fireBigOrderAlert(sym, dir, vol, price)
    }
  }
}


/** 实时 K 线 bar 数据（WebSocket 推送） */
export interface KlineRealtimeBar {
  symbol: string
  period: string
  bar: KlineBar
}

/** 行情 Store 状态 */
interface MarketState {
  /** WebSocket 连接状态 */
  connectionState: ConnectionState
  /** 实时行情数据（按合约代码索引） */
  quotes: Record<string, QuoteData>
  /** 价格变动闪烁标记（symbol → { seq, direction }） */
  flashMap: Record<string, { seq: number; direction: FlashDirection }>
  /** 盘口数据（按合约代码索引） */
  orderbooks: Record<string, OrderBook>
  /** 成交记录（按合约代码索引） */
  trades: Record<string, TradeRecord[]>
  /** K 线历史数据（symbol → period → bars） */
  klineBars: Record<string, Record<KlinePeriod, KlineBar[]>>
  /** K 线实时最新 bar（symbol → period → bar） */
  klineRealtime: Record<string, Record<KlinePeriod, KlineBar>>
  /** K 线 WS 订阅引用计数（symbol → 订阅中的图表数；并集下发给服务端） */
  klineWatchSymbols: Record<string, number>
  /** K 线历史加载状态（symbol:period → loading） */
  klineLoading: Record<string, boolean>
  /** K 线是否还有更早数据可加载（symbol:period → hasMore） */
  klineHasMore: Record<string, boolean>
  /** 合约列表是否加载中 */
  contractsLoading: boolean
  /** WebSocket 是否已初始化 */
  wsInitialized: boolean
  /** 按品种代码分组的合约树(三级菜单数据) */
  codeTree: CodeTreeMap | null
  /** 合约树加载状态 */
  codeTreeLoading: boolean
  /** 最新全量新闻 */
  latestNews: NewsItem[]
  /** 品种关联新闻（symbol → 新闻列表） */
  contractNews: Record<string, NewsItem[]>
  /** 新闻查看器：当前选中的新闻 */
  selectedNews: NewsItem | null
  /** 新闻查看器：是否打开 */
  newsViewerOpen: boolean

  /** 初始化 WebSocket 连接（首次调用时生效） */
  initWebSocket: () => void
  /** 更新连接状态 */
  setConnectionState: (state: ConnectionState) => void
  /** 设置 K 线 WS 订阅（服务端只推订阅合约的 forming bar；空数组恢复全量） */
  setWsKlineSubscription: (symbols: string[]) => void
  /** 图表挂载：登记关注的合约（引用计数；多分屏取并集） */
  watchKlineSymbol: (symbol: string) => void
  /** 图表卸载：解除关注（计数归零才真正取消订阅） */
  unwatchKlineSymbol: (symbol: string) => void
  /** 批量更新行情数据 */
  updateQuotes: (data: QuoteData[]) => void
  /** 批量更新盘口数据 */
  updateOrderbooks: (data: OrderBook[]) => void
  /** 批量更新成交记录 */
  updateTrades: (data: Record<string, TradeRecord[]>) => void
  /** 设置 K 线历史数据 */
  setKlineBars: (symbol: string, period: KlinePeriod, bars: KlineBar[]) => void
  /** 更新 K 线实时 bar */
  updateKlineRealtime: (data: KlineRealtimeBar[]) => void
  /** 在现有 K 线数据前面拼接更早的历史 bar（去重） */
  prependKlineBars: (symbol: string, period: KlinePeriod, olderBars: KlineBar[]) => void
  /** 更新 K 线实时 bar */
  setKlineLoading: (key: string, loading: boolean) => void
  /** 设置 K 线是否还有更早数据 */
  setKlineHasMore: (key: string, hasMore: boolean) => void
  /** 设置合约加载状态 */
  setContractsLoading: (loading: boolean) => void
  /** 设置合约树数据 */
  setCodeTree: (data: CodeTreeMap | null) => void
  /** 拉取合约树(调用 /by-code 接口) */
  fetchCodeTree: () => Promise<void>
  /** 更新最新全量新闻 */
  setLatestNews: (news: NewsItem[]) => void
  /** 更新品种关联新闻 */
  setContractNews: (symbol: string, news: NewsItem[]) => void
  /** 打开新闻查看器 */
  openNewsViewer: (news: NewsItem) => void
  /** 关闭新闻查看器 */
  closeNewsViewer: () => void
}

/** 行情 Store */
export const useMarketStore = create<MarketState>((set, get) => ({
  connectionState: "disconnected",
  quotes: {},
  flashMap: {},
  orderbooks: {},
  trades: {},
  klineBars: {},
  klineRealtime: {},
  klineWatchSymbols: {},
  klineLoading: {},
  klineHasMore: {},
  contractsLoading: false,
  wsInitialized: false,
  codeTree: null,
  codeTreeLoading: false,
  latestNews: [],
  contractNews: {},
  selectedNews: null,
  newsViewerOpen: false,

  initWebSocket: () => {
    const ws = getMarketWebSocket()

    // 已绑定过回调时只补 connect（登录后 token 就绪 / 页面二次进入）
    if (get().wsInitialized) {
      ws.connect()
      // 补一次 HTTP 快照，避免 WS 短暂断线后侧栏空白
      void bootstrapQuotesFromHttp(get)
      return
    }
    set({ wsInitialized: true })

    // 监听连接状态
    ws.onStateChange((state) => {
      set({ connectionState: state })
    })

    // 监听消息，按 type 分发
    ws.onMessage((message: WsMessage) => {
      if (message.type === "quote" && Array.isArray(message.data)) {
        get().updateQuotes(message.data as QuoteData[])
      } else if (message.type === "orderbook" && Array.isArray(message.data)) {
        get().updateOrderbooks(message.data as OrderBook[])
      } else if (message.type === "trades" && message.data && typeof message.data === "object") {
        get().updateTrades(message.data as Record<string, TradeRecord[]>)
      } else if (message.type === "kline" && Array.isArray(message.data)) {
        get().updateKlineRealtime(message.data as KlineRealtimeBar[])
      } else if (message.type === "notification" && message.data && typeof message.data === "object") {
        // 新消息推送：后端字段为 snake_case（created_at），前端 Message 用 createdAt
        const raw = message.data as Record<string, unknown>
        const msg: Message = {
          id: String(raw.id),
          category: raw.category as MessageCategory,
          title: String(raw.title ?? ""),
          content: String(raw.content ?? ""),
          read: Boolean(raw.read ?? false),
          createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
        }
        const ns = useNotificationsStore.getState()
        ns.showPopup(msg)
        ns.setUnread(ns.unread + 1)
        playNotificationSound()
      } else if (message.type === "unread_count" && message.data && typeof message.data === "object") {
        // 未读数同步：data.unread 为后端权威值
        const raw = message.data as { unread?: number }
        if (typeof raw.unread === "number") {
          useNotificationsStore.getState().setUnread(raw.unread)
        }
      } else if (message.type === "big_order_tick" && message.data && typeof message.data === "object") {
        // 大单原始事件：后端只做市场级显著放量筛选，前端按用户阈值二次判定。
        // 命中则入库记录 + 弹窗 + 语音 + 提示音（各开关由用户设置控制）。
        void handleBigOrderTick(message.data as Record<string, unknown>)
      } else if (message.type === "task_order_tick" && message.data && typeof message.data === "object") {
        // 任务下单/平仓事件（服务端按 user_id 定向，仅本人任务）：
        // AI 看盘任务预警 —— 弹窗/语音/提示音 + 选中任务标记/记录联动刷新。
        handleTaskOrderTick(message.data as Record<string, unknown>)
      } else if (message.type === "anchor_broadcast" && message.data && typeof message.data === "object") {
        // AI 看盘主播播报（服务端按 user_id 定向）：ai-anchor store 负责盘模式
        // 过滤/去重/列表更新与语音朗读；主播本体在后端，跳页不影响。
        useAiAnchorStore.getState().receiveWsBroadcast(message.data as Record<string, unknown>)
      }
    })

    // 重连成功：服务端会重推 Redis 缓存的 quote/orderbook/kline realtime；
    // 历史 K 线缺口由 kline-chart 监听 connectionState 回补
    ws.onOpen(({ isReconnect }) => {
      if (isReconnect) {
        set({ connectionState: "connected" })
      }
    })

    // 首屏 HTTP 快照：即使 JWT 过期导致 WS 暂断，侧栏也能先出价格
    void bootstrapQuotesFromHttp(get)
    ws.connect()
  },

  setConnectionState: (state) => set({ connectionState: state }),

  setWsKlineSubscription: (symbols) => {
    getMarketWebSocket().setKlineSubscription(symbols)
  },

  watchKlineSymbol: (symbol) => {
    const sym = symbol.trim().toLowerCase()
    if (!sym) return
    const next = { ...get().klineWatchSymbols }
    next[sym] = (next[sym] ?? 0) + 1
    set({ klineWatchSymbols: next })
    getMarketWebSocket().setKlineSubscription(Object.keys(next))
  },

  unwatchKlineSymbol: (symbol) => {
    const sym = symbol.trim().toLowerCase()
    if (!sym) return
    const prev = get().klineWatchSymbols
    const count = prev[sym] ?? 0
    if (count <= 1) {
      const next = { ...prev }
      delete next[sym]
      set({ klineWatchSymbols: next })
      getMarketWebSocket().setKlineSubscription(Object.keys(next))
      return
    }
    set({ klineWatchSymbols: { ...prev, [sym]: count - 1 } })
  },

  updateQuotes: (data) =>
    set((state) => {
      const updated = { ...state.quotes }
      const flash = { ...state.flashMap }
      for (const quote of data) {
        const prev = state.quotes[quote.symbol]
        updated[quote.symbol] = quote
        if (prev && quote.last_price !== prev.last_price) {
          const direction: FlashDirection = quote.last_price > prev.last_price ? "up" : "down"
          flash[quote.symbol] = { seq: (flash[quote.symbol]?.seq ?? 0) + 1, direction }
        }
      }
      return { quotes: updated, flashMap: flash }
    }),

  updateOrderbooks: (data) =>
    set((state) => {
      const updated = { ...state.orderbooks }
      for (const ob of data) {
        updated[ob.symbol] = ob
      }
      return { orderbooks: updated }
    }),

  updateTrades: (data) => {
    set((state) => {
      const updated = { ...state.trades }
      for (const [symbol, records] of Object.entries(data)) {
        updated[symbol] = records
      }
      return { trades: updated }
    })
    // 扫描新成交记录，命中用户阈值则入库 + 预警（与列表高亮同源同口径）
    void scanTradesForBigOrder(data)
  },

  setKlineBars: (symbol, period, bars) =>
    set((state) => {
      const symbolMap = { ...(state.klineBars[symbol] ?? {}) }
      symbolMap[period] = bars
      return { klineBars: { ...state.klineBars, [symbol]: symbolMap } }
    }),

  prependKlineBars: (symbol, period, olderBars) =>
    set((state) => {
      const existing = state.klineBars[symbol]?.[period] ?? []
      if (olderBars.length === 0) return state
      // 用 time 去重：只保留 existing 中不存在于 olderBars 的 bar
      const olderTimes = new Set(olderBars.map((b) => b.time))
      const uniqueExisting = existing.filter((b) => !olderTimes.has(b.time))
      const merged = [...olderBars, ...uniqueExisting]
      const symbolMap = { ...(state.klineBars[symbol] ?? {}) }
      symbolMap[period] = merged
      return { klineBars: { ...state.klineBars, [symbol]: symbolMap } }
    }),

  updateKlineRealtime: (data) =>
    set((state) => {
      const realtime = { ...state.klineRealtime }
      for (const item of data) {
        const period = item.period as KlinePeriod
        const symbolMap = { ...(realtime[item.symbol] ?? {}) }
        // 版本号幂等守卫：同 (symbol, period) 只接受不低于本地版本的 bar，
        // 乱序/重放/旧快照不回退（version 缺失视为 0，兼容无版本推送）
        const prev = symbolMap[period]
        if (
          prev &&
          prev.time === item.bar.time &&
          (prev.version ?? 0) > (item.bar.version ?? 0)
        ) {
          continue
        }
        symbolMap[period] = item.bar
        realtime[item.symbol] = symbolMap
      }
      return { klineRealtime: realtime }
    }),

  setKlineLoading: (key, loading) =>
    set((state) => ({
      klineLoading: { ...state.klineLoading, [key]: loading },
    })),

  setKlineHasMore: (key, hasMore) =>
    set((state) => ({
      klineHasMore: { ...state.klineHasMore, [key]: hasMore },
    })),

  setContractsLoading: (loading) => set({ contractsLoading: loading }),

  setCodeTree: (data) => set({ codeTree: data }),

  fetchCodeTree: async () => {
    if (get().codeTreeLoading) return
    set({ codeTreeLoading: true })
    try {
      const data = await getContractsByCodeApi()
      set({ codeTree: data })
    } catch (err) {
      console.error("合约树加载失败:", err)
    } finally {
      set({ codeTreeLoading: false })
    }
  },

  setLatestNews: (news) => set({ latestNews: news }),

  setContractNews: (symbol, news) =>
    set((state) => ({
      contractNews: { ...state.contractNews, [symbol]: news },
    })),

  openNewsViewer: (news) => set({ selectedNews: news, newsViewerOpen: true }),

  closeNewsViewer: () => set({ newsViewerOpen: false, selectedNews: null }),
}))
