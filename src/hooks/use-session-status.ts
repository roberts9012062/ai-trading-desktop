"use client"

/**
 * 轮询合约交易时段状态
 * - live：国内交易日历
 * - virtual：7×24，并反映 openctp 是否有价
 */

import { useCallback, useEffect, useState } from "react"
import { getSessionStatusApi, type SessionStatus } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"

const POLL_MS = 30_000

/** 订阅指定合约的开盘状态 */
export function useSessionStatus(symbol: string): {
  status: SessionStatus | null
  isOpen: boolean
  message: string
  hasVirtualQuote: boolean | null
  refresh: () => Promise<void>
} {
  const tradingMode = useAuthStore((s) => s.user?.trading_mode ?? "live")
  const [status, setStatus] = useState<SessionStatus | null>(null)

  const refresh = useCallback(async () => {
    if (!symbol) return
    try {
      const data = await getSessionStatusApi(symbol)
      setStatus(data)
    } catch {
      // 网络失败时不强制改状态
    }
  }, [symbol])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh, tradingMode])

  const hasVirtualQuote =
    typeof status?.has_virtual_quote === "boolean"
      ? status.has_virtual_quote
      : null

  return {
    status,
    isOpen: status?.is_open === true,
    message: status?.message ?? "",
    hasVirtualQuote,
    refresh,
  }
}
