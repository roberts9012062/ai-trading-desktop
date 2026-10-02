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
import { getSessionStatusApi } from "@/lib/api"
import {
  cancelLiveOrderApi,
  closeLivePositionApi,
  getLiveAccountApi,
  getLiveOrdersApi,
  getLivePositionsApi,
  getStoredVenue,
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
  lastMessage: string | null
  loaded: boolean
  /** 清空账户/委托/持仓内存态（切换账号/查询失败时防上一账号数据残留） */
  reset: () => void

  setVenue: (venue: TradingVenue) => void
  refresh: () => Promise<void>
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
  lastMessage: null,
  loaded: false,

  clearMessage: () => set({ error: null, lastMessage: null }),

  setVenue: (venue) => {
    storeVenue(venue)
    set({ venue, orders: [], positions: [], account: null, loaded: false })
    void get().refresh()
  },

  reset: () =>
    set({
      account: null,
      orders: [],
      positions: [],
      ledgers: [],
      loading: false,
      error: null,
      lastMessage: null,
      loaded: false,
    }),

  refresh: async () => {
    const mode = currentMode()
    set({ loading: true, error: null, mode })
    try {
      if (mode === "live") {
        const venue = getStoredVenue()
        let ordersError: string | null = null
        const [account, openOrders, historyOrders, positionsRes] =
          await Promise.all([
            getLiveAccountApi(venue),
            getLiveOrdersApi(venue, false).catch((e: unknown) => {
              ordersError =
                e instanceof Error ? e.message : "实盘挂单查询失败"
              return [] as PaperOrderItem[]
            }),
            getLiveOrdersApi(venue, true).catch(() => [] as PaperOrderItem[]),
            getLivePositionsApi(venue).catch(() => []),
          ])
        // 交易所挂单列表为准；历史镜像补充已终态委托（按交易所订单号去重）
        const seen = new Set(
          openOrders
            .map((o) => o.exchange_order_id || o.id)
            .filter((k): k is string => Boolean(k))
        )
        const merged = [...openOrders]
        for (const o of historyOrders) {
          const key = o.exchange_order_id || o.id
          if (key && seen.has(key)) continue
          // 镜像仍标记挂单中但交易所挂单列表已无此单 → 已终结
          if (o.status === "pending" || o.status === "partially_filled") {
            o.status =
              o.quantity > 0 && o.filled_qty >= o.quantity
                ? "filled"
                : "cancelled"
          }
          merged.push(o)
        }
        set({
          mode,
          venue,
          account,
          orders: merged,
          positions: positionsRes,
          ledgers: [],
          loading: false,
          loaded: true,
          error: ordersError,
        })
        return
      }
      const [account, ordersRes, positionsRes, ledgersRes] = await Promise.all([
        getPaperAccount(),
        getPaperOrders(null, 100, 0),
        getPaperPositions(),
        getPaperLedgers(50, 0),
      ])
      set({
        mode,
        account,
        orders: ordersRes.items,
        positions: positionsRes.items,
        ledgers: ledgersRes.items,
        loading: false,
        loaded: true,
      })
    } catch (err) {
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
  },

  place: async (input) => {
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
        set({
          submitting: false,
          lastMessage: `实盘委托已提交（${venue.toUpperCase()}）${input.symbol} ${direction === "buy" ? "买入" : "卖出"} ${input.quantity} @${input.orderType === "market" ? "市价" : input.price}`,
        })
        await get().refresh()
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
        await cancelLiveOrderApi(getStoredVenue(), orderId, order?.symbol ?? "")
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
      (o) => o.status === "pending" || o.status === "partially_filled"
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
            await cancelLiveOrderApi(getStoredVenue(), order.id, order.symbol)
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
