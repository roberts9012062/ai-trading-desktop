"use client"

/**
 * 下单面板状态与提交流程 hook
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import {
  estimateOpenCost,
  usePaperTradingStore,
} from "@/stores/paper-trading"
import {
  priceBand,
  resolveOpponentPrice,
  type PriceMode,
} from "@/components/trading/lib/order-price"
import { submitPaperOrder } from "@/components/trading/lib/order-submit"
import type { OrderDirection, OrderType } from "@/types"
import { useSessionStatus } from "@/hooks/use-session-status"

function pickQuote(
  quotes: Record<string, { last_price?: number; bid_price?: number; ask_price?: number; decimal_places?: number; name?: string; change?: number }>,
  symbol: string
) {
  return (
    quotes[symbol] ??
    quotes[symbol.toLowerCase()] ??
    quotes[symbol.toUpperCase()]
  )
}

export function useOrderPanel() {
  const activeContract = useAppStore((s) => s.activeContract)
  const setMarketStatus = useAppStore((s) => s.setMarketStatus)
  const tradePanelIntent = useAppStore((s) => s.tradePanelIntent)
  const clearTradePanelIntent = useAppStore((s) => s.clearTradePanelIntent)
  const quotes = useMarketStore((s) => s.quotes)
  const quote = pickQuote(quotes, activeContract)
  const klineBars = useMarketStore(
    (s) =>
      s.klineBars[activeContract]?.["1d"] ??
      s.klineBars[activeContract.toLowerCase()]?.["1d"] ??
      s.klineBars[activeContract]?.["5m"] ??
      s.klineBars[activeContract.toLowerCase()]?.["5m"]
  )
  const initWebSocket = useMarketStore((s) => s.initWebSocket)
  const account = usePaperTradingStore((s) => s.account)
  const positions = usePaperTradingStore((s) => s.positions)
  const submitting = usePaperTradingStore((s) => s.submitting)
  const error = usePaperTradingStore((s) => s.error)
  const lastMessage = usePaperTradingStore((s) => s.lastMessage)
  const place = usePaperTradingStore((s) => s.place)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const clearMessage = usePaperTradingStore((s) => s.clearMessage)
  const { status: session, isOpen, message: sessionMsg } =
    useSessionStatus(activeContract)

  const [direction, setDirection] = useState<OrderDirection>("buy")
  const [orderType, setOrderType] = useState<OrderType>("limit")
  const [priceMode, setPriceMode] = useState<PriceMode>("opponent")
  const [manualPrice, setManualPrice] = useState("")
  const [quantity, setQuantity] = useState("1")
  /** ===== r20 受保护下单模型 ===== */
  const [marginInput, setMarginInput] = useState("100")
  const [leverage, setLeverage] = useState(10)
  /** 保证金模式：全仓（账户共享）/ 逐仓（仓位独立强平线） */
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross")
  const [tpPrice, setTpPrice] = useState("")
  const [slPrice, setSlPrice] = useState("")
  /** 持仓点选指定要平的方向（多/空） */
  const [closePosDir, setClosePosDir] = useState<"long" | "short" | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [estimate, setEstimate] = useState<{
    margin: number
    fee: number
    total: number
  } | null>(null)

  const decimals = quote?.decimal_places ?? 0
  const klineLast =
    klineBars && klineBars.length > 0
      ? Number(klineBars[klineBars.length - 1]?.close ?? 0)
      : 0
  const lastPrice = quote?.last_price || klineLast || 0
  const bidPrice = quote?.bid_price || 0
  const askPrice = quote?.ask_price || 0
  const contractName = quote?.name ?? activeContract
  const closeable = useMemo(() => {
    const key = activeContract.toLowerCase()
    return positions.filter((p) => p.symbol.toLowerCase() === key)
  }, [positions, activeContract])
  const closeActionDir: OrderDirection = useMemo(() => {
    // 优先用点选持仓方向
    if (closePosDir === "long") return "sell"
    if (closePosDir === "short") return "buy"
    if (closeable.find((p) => p.direction === "long")) return "sell"
    if (closeable.find((p) => p.direction === "short")) return "buy"
    return "sell"
  }, [closeable, closePosDir])
  const effectiveDir: OrderDirection =
    direction === "close" ? closeActionDir : direction
  const opponentPrice = resolveOpponentPrice(
    effectiveDir,
    bidPrice,
    askPrice,
    lastPrice
  )
  // 平仓默认用最新价（市价）或对手价，保证一点即平
  const priceNum =
    orderType === "market"
      ? lastPrice
      : priceMode === "opponent"
        ? opponentPrice
        : Math.max(0, parseFloat(manualPrice) || 0)
  // 加密货币数量支持小数（基础币，如 0.001 BTC）
  const qtyNum = Math.max(0, parseFloat(quantity) || 0)
  // r20 模型：保证金×杠杆 → 自动数量与名义价值
  const marginNum = Math.max(0, parseFloat(marginInput) || 0)
  const autoQty = priceNum > 0 && marginNum > 0 ? marginNum * leverage / priceNum : 0
  const notional = marginNum * leverage
  const tpNum = Math.max(0, parseFloat(tpPrice) || 0)
  const slNum = Math.max(0, parseFloat(slPrice) || 0)
  // 盈亏比（r20 R:R 风格）：多头 = (TP-入场)/(入场-SL)
  const riskLen = effectiveDir === "buy" ? priceNum - slNum : slNum - priceNum
  const rewardLen = effectiveDir === "buy" ? tpNum - priceNum : priceNum - tpNum
  const rr = riskLen > 0 && rewardLen > 0 ? rewardLen / riskLen : null
  const available = account?.available_margin ?? 0
  const band = priceBand(lastPrice)
  const inBand = band.inBand(priceNum)
  const maxLots =
    estimate && estimate.total > 0
      ? Math.floor(available / (estimate.total / Math.max(qtyNum, 1)))
      : 0
  // 按钮文案：买多 / 卖空 / 平仓
  const submitLabel =
    direction === "buy"
      ? "买多"
      : direction === "sell"
        ? "卖空"
        : "平仓"
  const effQty = autoQty > 0 ? autoQty : qtyNum
  const canSubmit =
    !submitting &&
    effQty > 0 &&
    priceNum > 0 &&
    inBand &&
    !(!isOpen && orderType === "market")

  useEffect(() => {
    initWebSocket()
  }, [initWebSocket])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    // 虚拟盘 7×24 恒开；live 才跟 session.is_open
    if (session?.trading_mode === "virtual") {
      setMarketStatus("trading")
    } else if (session) {
      setMarketStatus(session.is_open ? "trading" : "closed")
    }
  }, [session, setMarketStatus])
  useEffect(() => {
    if (!isOpen && orderType === "market") setOrderType("limit")
  }, [isOpen, orderType])
  useEffect(() => {
    setManualPrice("")
    setPriceMode("opponent")
  }, [activeContract])

  // 指定价虚线预览：限价+手动模式时同步到 K 线（上下拨动价格即时移动）
  useEffect(() => {
    const setPreview = useAppStore.getState().setOrderPricePreview
    if (orderType === "limit" && priceMode === "manual" && priceNum > 0) {
      setPreview({
        seq: Date.now(),
        symbol: activeContract,
        price: priceNum,
        direction: effectiveDir === "buy" ? "buy" : "sell",
      })
    } else {
      setPreview(null)
    }
  }, [orderType, priceMode, priceNum, activeContract, effectiveDir])

  // 持仓/委托点击：联动下单区
  useEffect(() => {
    if (!tradePanelIntent) return
    if (tradePanelIntent.mode === "price") {
      if (tradePanelIntent.direction) setDirection(tradePanelIntent.direction)
      setClosePosDir(null)
      setOrderType("limit")
      setPriceMode("manual")
      if (tradePanelIntent.price && tradePanelIntent.price > 0) {
        setManualPrice(String(tradePanelIntent.price))
      }
    } else if (tradePanelIntent.mode === "close") {
      setDirection("close")
      setClosePosDir(tradePanelIntent.positionDirection)
      if (tradePanelIntent.quantity && tradePanelIntent.quantity > 0) {
        setQuantity(String(tradePanelIntent.quantity))
      }
      // 开盘用市价最新价一点即平；休市则限价挂单
      setOrderType(isOpen ? "market" : "limit")
      setPriceMode("opponent")
    } else {
      setClosePosDir(null)
    }
    clearTradePanelIntent()
  }, [tradePanelIntent, clearTradePanelIntent, isOpen])

  useEffect(() => {
    if (priceMode === "manual" && !manualPrice && opponentPrice > 0) {
      setManualPrice(String(opponentPrice))
    }
  }, [priceMode, opponentPrice, manualPrice])
  useEffect(() => {
    if (direction === "close" || priceNum <= 0 || qtyNum <= 0) {
      setEstimate(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void estimateOpenCost(activeContract, priceNum, qtyNum).then((res) => {
        if (!cancelled) setEstimate(res)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [activeContract, priceNum, qtyNum, direction])

  const doPlace = useCallback(async () => {
    // 平仓时按指定持仓方向筛选
    let targets = closeable
    if (direction === "close" && closePosDir) {
      targets = closeable.filter((p) => p.direction === closePosDir)
      if (targets.length === 0) targets = closeable
    }
    await submitPaperOrder({
      isOpen,
      orderType: orderType === "market" ? "market" : "limit",
      sessionMsg,
      priceNum,
      inBand,
      bandMin: band.min,
      bandMax: band.max,
      direction,
      closeable: targets,
      activeContract,
      contractName,
      qtyNum: effQty,
      place,
      clearMessage,
      marginUsdt: autoQty > 0 ? marginNum : null,
      leverage: autoQty > 0 ? leverage : null,
      marginMode,
      tpPrice: direction !== "close" && tpNum > 0 ? tpNum : null,
      slPrice: direction !== "close" && slNum > 0 ? slNum : null,
    })
  }, [
    activeContract,
    band.max,
    band.min,
    clearMessage,
    closePosDir,
    closeable,
    contractName,
    direction,
    inBand,
    isOpen,
    orderType,
    place,
    priceNum,
    qtyNum,
    sessionMsg,
    marginMode,
  ])

  const handleSubmitClick = () => {
    clearMessage()
    if (!canSubmit) {
      if (priceNum <= 0) {
        usePaperTradingStore.setState({ error: "请填写委托价格" })
      }
      return
    }
    if (
      priceMode === "opponent" ||
      orderType === "market" ||
      direction === "close"
    ) {
      void doPlace()
      return
    }
    setConfirmOpen(true)
  }

  return {
    activeContract,
    account,
    session,
    isOpen,
    direction,
    setDirection,
    orderType,
    setOrderType,
    priceMode,
    setPriceMode,
    manualPrice,
    setManualPrice,
    quantity,
    setQuantity,
    marginInput,
    setMarginInput,
    leverage,
    marginMode,
    setMarginMode,
    setLeverage,
    tpPrice,
    setTpPrice,
    slPrice,
    setSlPrice,
    autoQty,
    notional,
    rr,
    confirmOpen,
    setConfirmOpen,
    estimate,
    decimals,
    lastPrice,
    bidPrice,
    askPrice,
    contractName,
    closeable,
    effectiveDir,
    priceNum,
    available,
    band,
    inBand,
    maxLots,
    submitLabel,
    canSubmit,
    submitting,
    error,
    lastMessage,
    clearMessage,
    doPlace,
    handleSubmitClick,
    change: quote?.change ?? 0,
    closePosDir,
  }
}

