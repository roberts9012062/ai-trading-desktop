/**
 * 下单提交流程（纯逻辑，无 JSX）
 */

import {
  usePaperTradingStore,
  type PlaceInput,
} from "@/stores/paper-trading"
import type { OrderDirection } from "@/types"
import type { PaperPositionItem } from "@/lib/paper-api"

export type SubmitParams = {
  isOpen: boolean
  orderType: "limit" | "market"
  sessionMsg: string
  priceNum: number
  inBand: boolean
  bandMin: number
  bandMax: number
  direction: OrderDirection
  closeable: PaperPositionItem[]
  activeContract: string
  contractName: string
  qtyNum: number
  place: (input: PlaceInput) => Promise<unknown>
  clearMessage: () => void
  /** r20 模型：保证金+杠杆自动算量 + 止盈止损 */
  marginUsdt?: number | null
  leverage?: number | null
  tpPrice?: number | null
  slPrice?: number | null
}

/** 执行下单；错误写入 paper store */
export async function submitPaperOrder(p: SubmitParams): Promise<void> {
  p.clearMessage()
  if (!p.isOpen && p.orderType === "market") {
    usePaperTradingStore.setState({
      error: p.sessionMsg || "非交易时段请使用限价挂单",
    })
    return
  }
  if (p.priceNum <= 0) {
    usePaperTradingStore.setState({
      error: "无有效价格，请切换指定价或等待行情",
    })
    return
  }
  if (!p.inBand) {
    usePaperTradingStore.setState({
      error: `价格须在最新价 ±10% 内（${p.bandMin.toFixed(2)} ~ ${p.bandMax.toFixed(2)}）`,
    })
    return
  }
  const ot = p.orderType === "market" ? "market" : "limit"
  if (p.direction === "close") {
    const pos =
      p.closeable.find((x) => x.direction === "long") ??
      p.closeable.find((x) => x.direction === "short")
    if (!pos) {
      usePaperTradingStore.setState({ error: "当前合约无可平持仓" })
      return
    }
    // 用持仓原始 symbol，避免大小写导致后端对不上
    await p.place({
      symbol: pos.symbol || p.activeContract,
      symbolName: pos.symbol_name || p.contractName,
      action: "close",
      orderType: ot,
      price: p.priceNum,
      quantity: Math.min(p.qtyNum, pos.available_quantity),
      positionDirection: pos.direction === "short" ? "short" : "long",
    })
    return
  }
  await p.place({
    symbol: p.activeContract,
    symbolName: p.contractName,
    action: p.direction,
    orderType: ot,
    price: p.priceNum,
    quantity: p.qtyNum,
    positionDirection: null,
    marginUsdt: p.marginUsdt ?? null,
    leverage: p.leverage ?? null,
    tpPrice: p.tpPrice ?? null,
    slPrice: p.slPrice ?? null,
  })
}
