"use client"

/**
 * 交易状态 —— 账户 / 委托 / 持仓 / 下单撤单
 *
 * 双模式统一入口（对外保持 usePaperTradingStore 名称，组件零改动）：
 * - virtual：虚拟盘（模拟撮合，/api/paper/*）
 * - live：实盘（OKX / Binance / Gate 三所真实下单，/api/live/*，
 *   venue 为当前所选交易所）
 */

import { create } from "zustand"
import { mergeLiveOrders, canCancelLiveOrder } from "@/lib/live-order-merge"
import { getSessionStatusApi } from "@/lib/api"
import {
  cancelLiveOrderApi,
  closeLivePositionApi,
  getLiveAccountApi,
  getLiveOrdersApi,
  getLivePositionsApi,
  getStoredVenue,
  liveErrorMessage,
  placeLiveOrderApi,
  storeVenue,
  type TradingVenue,
} from "@/lib/live-api"
import {
  cancelPaperOrder,
  estimatePaperOrder,
  getPaperAccount,
  getPaperLedgers,
  getPaperOrders,
  getPaperPositions,
  placePaperOrder,
  type PaperAccountSummary,
  type PaperLedgerItem,
  type PaperOrderItem,
  type PaperPositionItem,
  type PlacePaperOrderRequest,
} from "@/lib/paper-api"
import { useAuthStore } from "@/stores/auth"
import { RefreshCoordinator } from '@/lib/refresh-coordinator'

const refreshCoordinator = new RefreshCoordinator()
const liveReadErrors = new Map<string, string>()
const liveReadVersions = new Map<string, number>()
let refreshGeneration = 0
function refreshOwner(): string {
  const user = useAuthStore.getState().user
  return JSON.stringify([refreshGeneration, user?.id, user?.trading_mode, getStoredVenue(), typeof window === 'undefined' ? '' : window.__QH_API_BASE__])
}

/** 下单入参（面板 / 持仓平仓共用） */
export interface PlaceInput {
  symbol: string
  symbolName: string
  /** buy / sell 开仓；close 时由 positionDirection 决定 */
  action: "buy" | "sell" | "close"
  orderType: "limit" | "market"
  price: number
  quantity: number
  /** 平仓时指定原持仓方向 long/short */
  positionDirection: "long" | "short" | null
  /** 来源 manual/ai/quant（平仓按 source 平对应仓；实盘忽略） */
  source?: "manual" | "ai" | "quant"
  /** ===== r20 受保护下单模型 ===== */
  marginUsdt?: number | null
  leverage?: number | null
  /** 保证金模式 cross 全仓 / isolated 逐仓（实盘下发交易所；虚拟盘记账同） */
  marginMode?: "cross" | "isolated"
  tpPrice?: number | null
  slPrice?: number | null
}

interface PaperTradingState {
  /** 当前登录交易模式（live=实盘 / virtual=虚拟盘） */
  mode: "live" | "virtual"
  /** 实盘当前交易所（virtual 模式无意义） */
  venue: TradingVenue
  account: PaperAccountSummary | null
  orders: PaperOrderItem[]
  positions: PaperPositionItem[]
  ledgers: PaperLedgerItem[]
  loading: boolean
  submitting: boolean
  error: string | null
  historyError: string | null
  lastMessage: string | null
  loaded: boolean
  liveSyncConnected: boolean
  liveSyncAt: number
  lastRefreshAt: number
  /** 清空账户/委托/持仓内存态（切换账号/查询失败时防上一账号数据残留） */
  reset: () => void

  setVenue: (venue: TradingVenue) => void
  refresh: (options?: { afterCurrent?: boolean; sections?: Array<'account' | 'positions' | 'orders'> }) => Promise<void>
  place: (input: PlaceInput) => Promise<PaperOrderItem | null>
  cancel: (orderId: string) => Promise<void>
  cancelAllPending: () => Promise<void>
  closePosition: (
    position: PaperPositionItem,
    price: number,
    orderType: "limit" | "market",
    quantity: number
  ) => Promise<void>
  clearMessage: () => void
}

/** 当前登录模式（登录后 JWT/user 内绑定，切换需重新登录） */
function currentMode(): "live" | "virtual" {
  const mode = useAuthStore.getState().user?.trading_mode
  return mode === "virtual" ? "virtual" : "live"
}

/** 将 UI 操作映射为后端 direction + offset */
function mapAction(input: PlaceInput): {
  direction: "buy" | "sell"
  offset: "open" | "close"
} {
  if (input.action === "close") {
    // 平多 = 卖出；平空 = 买入
    const direction =
      input.positionDirection === "short" ? "buy" : "sell"
    return { direction, offset: "close" }
  }
  return { direction: input.action, offset: "open" }
}

export const usePaperTradingStore = create<PaperTradingState>((set, get) => ({
  mode: "live",
  venue: "okx",
  account: null,
  orders: [],
  positions: [],
  ledgers: [],
  loading: false,
  submitting: false,
  error: null,
  historyError: null,
  lastMessage: null,
  loaded: false,
  liveSyncConnected: false,
  liveSyncAt: 0,
  lastRefreshAt: 0,

  clearMessage: () => set({ error: null, historyError: null, lastMessage: null }),

  setVenue: (venue) => {
    refreshGeneration++
    liveReadErrors.clear()
    storeVenue(venue)
    set({ venue, orders: [], positions: [], account: null, loaded: false, historyError: null, liveSyncConnected: false, liveSyncAt: 0 })
    void get().refresh()
  },

  reset: () => {
    refreshGeneration++
    liveReadErrors.clear()
    set({
      account: null,
      orders: [],
      positions: [],
      ledgers: [],
      loading: false,
      error: null,
      historyError: null,
      lastMessage: null,
      loaded: false,
      submitting: false,
      liveSyncConnected: false,
      liveSyncAt: 0,
      lastRefreshAt: 0,
    })
  },

  refresh: (options) => {
    const owner = refreshOwner()
    const sections = new Set(options?.sections ?? ['account', 'positions', 'orders'])
    const full = sections.size === 3
    return refreshCoordinator.run(owner+':'+[...sections].sort().join(','), async () => {
    if (owner !== refreshOwner()) return
    const mode = currentMode()
    const current = () => owner === refreshOwner()
    if (full || mode !== 'live') set({ loading: true, error: null, mode })
    try {
      if (mode === "live") {
        const venue = getStoredVenue()
        const versions = new Map([...sections].map(part => {
          const version = (liveReadVersions.get(part) ?? 0) + 1
          liveReadVersions.set(part, version)
          return [part, version] as const
        }))
        const currentPart = (part: 'account' | 'positions' | 'orders') => current() && versions.get(part) === liveReadVersions.get(part)
        const failed = (part: 'account' | 'positions' | 'orders', error: unknown) => {
          if (!currentPart(part)) return
          liveReadErrors.set(part, error instanceof Error ? error.message : '交易状态查询失败')
          set(part === 'account' ? { account: null } : part === 'positions' ? { positions: [] } : { orders: [] })
        }
        // Each section paints as soon as it arrives. Slow order history must
        // not hide already received positions or account information.
        await Promise.all([
          sections.has('account') ? getLiveAccountApi(venue).then(account => { if (currentPart('account')) { liveReadErrors.delete('account');set({ account }) } }).catch(e => failed('account', e)) : Promise.resolve(),
          sections.has('positions') ? getLivePositionsApi(venue).then(positions => { if (currentPart('positions')) { liveReadErrors.delete('positions');set({ positions }) } }).catch(e => failed('positions', e)) : Promise.resolve(),
          sections.has('orders') ? Promise.all([
            getLiveOrdersApi(venue, false).then(open => {
              if (currentPart('orders')) { liveReadErrors.delete('orders');set({ orders: mergeLiveOrders(open, get().orders) }) }
              return open
            }),
            getLiveOrdersApi(venue, true).then(history => { if (currentPart('orders')) liveReadErrors.delete('history');return history }).catch(e => {
              if (!currentPart('orders')) return [] as PaperOrderItem[]
              liveReadErrors.set('history', `历史委托更新失败：${liveErrorMessage(e, '网络连接异常')}`)
              return get().orders
            }),
          ])
            .then(([open, history]) => { if (currentPart('orders')) set({ orders: mergeLiveOrders(open, history) }) }).catch(e => failed('orders', e)) : Promise.resolve(),
        ])
        if (current()) set({ mode, venue, ledgers: [], loaded: true,
          error: [...liveReadErrors].filter(([part]) => part !== 'history').map(([, message]) => message).join('；') || null,
          historyError: liveReadErrors.get('history') || null,
          ...(full ? { loading: false, lastRefreshAt: Date.now() } : {}) })
        return
      }
      const [account, ordersRes, positionsRes, ledgersRes] = await Promise.all([
        getPaperAccount(),
        getPaperOrders(null, 100, 0),
        getPaperPositions(),
        getPaperLedgers(50, 0),
      ])
      if (!current()) return
      set({
        mode,
        account,
        orders: ordersRes.items,
        positions: positionsRes.items,
        ledgers: ledgersRes.items,
        loading: false,
        loaded: true,
        lastRefreshAt: Date.now(),
      })
    } catch (err) {
      if (!current()) return
      // 查询失败也必须清空业务数据：否则残留的可能是上一账号
      // （或上一交易所）的持仓/委托——安全隔离不允许"失败时显示旧数据"
      set({
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : "加载交易账户失败",
        account: null,
        orders: [],
        positions: [],
        ledgers: [],
      })
    }
    }, options?.afterCurrent)
  },

  place: async (input) => {
    const owner = refreshOwner()
    set({ submitting: true, error: null, lastMessage: null })
    try {
      const { direction, offset } = mapAction(input)
      if (!input.price || input.price <= 0) {
        throw new Error("请输入有效价格（限价为委托价，市价用最新价）")
      }
      if (!input.marginUsdt && (!input.quantity || input.quantity <= 0)) {
        throw new Error("请输入有效数量或保证金")
      }

      // ===== 实盘：三所真实下单 =====
      if (get().mode === "live") {
        const venue = getStoredVenue()
        const order = (await placeLiveOrderApi({
          venue,
          symbol: input.symbol,
          direction,
          offset,
          order_type: input.orderType,
          price: input.orderType === "market" ? null : input.price,
          quantity: input.marginUsdt ? null : input.quantity,
          margin_usdt: input.marginUsdt ?? null,
          leverage: input.leverage ?? null,
          tp_price: input.tpPrice ?? null,
          sl_price: input.slPrice ?? null,
          reduce_only: offset === "close",
          margin_mode: input.marginMode ?? "cross",
        })) as unknown as PaperOrderItem
        if (owner !== refreshOwner()) return order
        set({
          submitting: false,
          lastMessage: `实盘委托已提交（${venue.toUpperCase()}）${input.symbol} ${direction === "buy" ? "买入" : "卖出"} ${input.quantity} @${input.orderType === "market" ? "市价" : input.price}`,
        })
        // The exchange ACK has arrived; subsequent reads are background work.
        // Keep the returned state (live/partially filled/etc.), never invent a fill.
        set({ orders: [{ ...order, status: order.status === 'live' ? 'pending' : order.status }, ...get().orders.filter(o => o.id !== order.id)] })
        void get().refresh({ afterCurrent: true })
        return order
      }

      // ===== 虚拟盘：模拟撮合 =====
      // 市价单才校验开盘；限价单允许盘前挂单（后端最终裁决）
      if (input.orderType === "market") {
        try {
          const st = await getSessionStatusApi(input.symbol)
          if (!st.is_open) {
            throw new Error(
              st.message || "非交易时段不可市价下单，请改用限价挂单"
            )
          }
        } catch (e) {
          if (
            e instanceof Error &&
            (e.message.includes("时段") ||
              e.message.includes("休市") ||
              e.message.includes("市价"))
          ) {
            throw e
          }
          // 时段接口失败时交给后端
        }
      }

      // 前端预检：相对最新价 ±10%（refPrice 由下单面板传入时更准；此处用 estimate 再兜底）
      try {
        const est = await estimatePaperOrder({
          symbol: input.symbol,
          price: input.price,
          quantity: input.quantity,
          offset,
        })
        const band = (
          est as {
            price_band?: {
              in_band?: boolean
              min_price?: number
              max_price?: number
              last_price?: number
            }
          }
        ).price_band
        if (band && band.in_band === false) {
          throw new Error(
            `委托价 ${input.price} 超出最新价 ${band.last_price} 的 ±10% 范围（允许 ${band.min_price} ~ ${band.max_price}）`
          )
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("±10%")) throw e
        // estimate 失败则交给后端
      }
      const body: PlacePaperOrderRequest = {
        symbol: input.symbol,
        direction,
        offset,
        order_type: input.orderType,
        price: input.price,
        quantity: input.quantity,
        symbol_name: input.symbolName,
        multiplier: null,
        margin_rate: null,
        source: input.source || "manual",
        margin_usdt: input.marginUsdt ?? null,
        leverage: input.leverage ?? null,
        tp_price: input.tpPrice ?? null,
        sl_price: input.slPrice ?? null,
      }
      const order = await placePaperOrder(body)
      if (owner !== refreshOwner()) return order
      const tradeParams = (order as PaperOrderItem & {
        trade_params?: { pre_market?: boolean }
        message?: string
      }).trade_params
      const serverMsg = (order as PaperOrderItem & { message?: string }).message
      const msg =
        order.status === "filled"
          ? `成交 ${order.symbol} ${order.filled_qty} @${order.price}，手续费 ${order.fee} USDT`
          : order.status === "pending"
            ? serverMsg ||
              (tradeParams?.pre_market
                ? `盘前挂单 ${order.symbol} ${order.quantity} @${order.price}，开盘到价成交`
                : `已挂单 ${order.symbol} ${order.quantity} @${order.price}`)
            : `委托状态：${order.status}`
      set({ submitting: false, lastMessage: msg })
      await get().refresh()
      return order
    } catch (err) {
      if (owner !== refreshOwner()) return null
      set({
        submitting: false,
        error: err instanceof Error ? err.message : "下单失败",
      })
      return null
    }
  },

  cancel: async (orderId) => {
    set({ submitting: true, error: null })
    try {
      if (get().mode === "live") {
        const order = get().orders.find((o) => o.id === orderId)
        if (!order || !canCancelLiveOrder(order)) throw new Error("该委托不能通过普通撤单接口撤销，请在所属任务或交易所管理条件单")
        await cancelLiveOrderApi(getStoredVenue(), order.exchange_order_id || orderId, order.symbol)
        set({ submitting: false, lastMessage: "撤单请求已发送" })
      } else {
        await cancelPaperOrder(orderId)
        set({ submitting: false, lastMessage: "撤单成功" })
      }
      await get().refresh()
    } catch (err) {
      set({
        submitting: false,
        error: err instanceof Error ? err.message : "撤单失败",
      })
    }
  },

  cancelAllPending: async () => {
    const pending = get().orders.filter(
      (o) => get().mode === "live" ? canCancelLiveOrder(o) : (o.status === "pending" || o.status === "partially_filled")
    )
    if (pending.length === 0) {
      set({ lastMessage: "无待撤委托" })
      return
    }
    set({ submitting: true, error: null })
    try {
      if (get().mode === "live") {
        let ok = 0
        for (const order of pending) {
          try {
            await cancelLiveOrderApi(getStoredVenue(), order.exchange_order_id || order.id, order.symbol)
            ok += 1
          } catch {
            // 单笔失败继续撤其余
          }
        }
        set({
          submitting: false,
          lastMessage: `已请求撤销 ${ok}/${pending.length} 笔委托`,
        })
      } else {
        for (const order of pending) {
          await cancelPaperOrder(order.id)
        }
        set({
          submitting: false,
          lastMessage: `已撤销 ${pending.length} 笔委托`,
        })
      }
      await get().refresh()
    } catch (err) {
      set({
        submitting: false,
        error: err instanceof Error ? err.message : "全撤失败",
      })
      await get().refresh()
    }
  },

  closePosition: async (position, price, orderType, quantity) => {
    if (get().mode === "live") {
      // 实盘：直接走交易所市价全平
      set({ submitting: true, error: null, lastMessage: null })
      try {
        await closeLivePositionApi(
          getStoredVenue(),
          position.symbol,
          position.direction === "short" ? "short" : "long"
        )
        set({
          submitting: false,
          lastMessage: `市价全平请求已发送（${getStoredVenue().toUpperCase()}）`,
        })
        await get().refresh()
      } catch (err) {
        set({
          submitting: false,
          error: err instanceof Error ? err.message : "平仓失败",
        })
      }
      return
    }
    await get().place({
      symbol: position.symbol,
      symbolName: position.symbol_name,
      action: "close",
      orderType,
      price,
      quantity,
      positionDirection: position.direction === "short" ? "short" : "long",
      source: (position.source as "manual" | "ai" | "quant") || "manual",
    })
  },
}))

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id || state.user?.trading_mode !== previous.user?.trading_mode) {
    usePaperTradingStore.getState().reset()
  }
})

/** 预估开仓占用（给下单面板展示；实盘模式返回 null 由交易所计收） */
export async function estimateOpenCost(
  symbol: string,
  price: number,
  quantity: number
): Promise<{ margin: number; fee: number; total: number } | null> {
  try {
    const res = await estimatePaperOrder({
      symbol,
      price,
      quantity,
      offset: "open",
    })
    return {
      margin: res.margin,
      fee: res.fee,
      total: res.total_needed,
    }
  } catch {
    return null
  }
}
