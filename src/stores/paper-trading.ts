"use client"

/**
 * 模拟交易状态 —— 账户 / 委托 / 持仓 / 下单撤单
 */

import { create } from "zustand"
import { getSessionStatusApi } from "@/lib/api"
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
  /** 来源 manual/ai/quant（平仓按 source 平对应仓） */
  source?: "manual" | "ai" | "quant"
}

interface PaperTradingState {
  account: PaperAccountSummary | null
  orders: PaperOrderItem[]
  positions: PaperPositionItem[]
  ledgers: PaperLedgerItem[]
  loading: boolean
  submitting: boolean
  error: string | null
  lastMessage: string | null
  loaded: boolean

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

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const [account, ordersRes, positionsRes, ledgersRes] = await Promise.all([
        getPaperAccount(),
        getPaperOrders(null, 100, 0),
        getPaperPositions(),
        getPaperLedgers(50, 0),
      ])
      set({
        account,
        orders: ordersRes.items,
        positions: positionsRes.items,
        ledgers: ledgersRes.items,
        loading: false,
        loaded: true,
      })
    } catch (err) {
      set({
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : "加载模拟账户失败",
      })
    }
  },

  place: async (input) => {
    set({ submitting: true, error: null, lastMessage: null })
    try {
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

      const { direction, offset } = mapAction(input)
      if (!input.price || input.price <= 0) {
        throw new Error("请输入有效价格（限价为委托价，市价用最新价）")
      }
      if (!input.quantity || input.quantity <= 0) {
        throw new Error("请输入有效手数")
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
      }
      const order = await placePaperOrder(body)
      const tradeParams = (order as PaperOrderItem & {
        trade_params?: { pre_market?: boolean }
        message?: string
      }).trade_params
      const serverMsg = (order as PaperOrderItem & { message?: string }).message
      const msg =
        order.status === "filled"
          ? `成交 ${order.symbol} ${order.filled_qty}手 @${order.price}，手续费 ¥${order.fee}`
          : order.status === "pending"
            ? serverMsg ||
              (tradeParams?.pre_market
                ? `盘前挂单 ${order.symbol} ${order.quantity}手 @${order.price}，开盘到价成交`
                : `已挂单 ${order.symbol} ${order.quantity}手 @${order.price}`)
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
      await cancelPaperOrder(orderId)
      set({ submitting: false, lastMessage: "撤单成功" })
      await get().refresh()
    } catch (err) {
      set({
        submitting: false,
        error: err instanceof Error ? err.message : "撤单失败",
      })
    }
  },

  cancelAllPending: async () => {
    const pending = get().orders.filter((o) => o.status === "pending")
    if (pending.length === 0) {
      set({ lastMessage: "无待撤委托" })
      return
    }
    set({ submitting: true, error: null })
    try {
      for (const order of pending) {
        await cancelPaperOrder(order.id)
      }
      set({
        submitting: false,
        lastMessage: `已撤销 ${pending.length} 笔委托`,
      })
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

/** 预估开仓占用（给下单面板展示） */
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
