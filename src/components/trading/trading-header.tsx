"use client"

/**
 * 交易页顶栏 —— 当前合约信息 + 切换入口（不展示自选/品种树）
 */

import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { useSessionStatus } from "@/hooks/use-session-status"
import { Button } from "@/components/ui/button"
import { Search } from "lucide-react"

/** 交易页合约条 */
export function TradingHeader(): React.JSX.Element {
  const activeContract = useAppStore((s) => s.activeContract)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const quote = useMarketStore((s) => s.quotes[activeContract])
  const { isOpen, status, hasVirtualQuote } = useSessionStatus(activeContract)
  const isVirtual = status?.trading_mode === "virtual"

  const name = quote?.name ?? activeContract
  const last = quote?.last_price
  const change = quote?.change ?? 0
  const changePct = quote?.change_pct ?? 0
  const decimals = quote?.decimal_places ?? 2
  const up = change >= 0

  /** 状态徽章：virtual 永不显示国内「休市/停盘」 */
  let badgeText = isOpen ? "交易中" : "休市"
  let badgeWarn = !isOpen
  if (isVirtual) {
    if (hasVirtualQuote === false && last == null) {
      badgeText = "暂无行情"
      badgeWarn = true
    } else if (hasVirtualQuote === false) {
      badgeText = "7×24·待源"
      badgeWarn = true
    } else {
      badgeText = "虚拟盘·7×24"
      badgeWarn = false
    }
  }

  return (
    <div className="h-10 shrink-0 flex items-center gap-3 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-sm font-semibold text-[var(--text-primary)] shrink-0">
          {activeContract}
        </span>
        <span className="text-xs text-[var(--text-muted)] truncate">{name}</span>
      </div>

      <div className="flex items-baseline gap-2 font-num">
        <span
          className={cn(
            "text-base font-semibold",
            last != null ? (up ? "text-up" : "text-down") : "text-[var(--text-muted)]"
          )}
        >
          {last != null ? last.toFixed(decimals) : "--"}
        </span>
        {last != null && (
          <span className={cn("text-xs", up ? "text-up" : "text-down")}>
            {up ? "+" : ""}
            {change.toFixed(decimals)} ({up ? "+" : ""}
            {changePct.toFixed(2)}%)
          </span>
        )}
      </div>

      <span
        className={cn(
          "text-[10px] px-1.5 py-0.5 rounded shrink-0",
          badgeWarn
            ? "bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]"
            : "bg-[var(--accent-up)]/15 text-[var(--accent-up)]"
        )}
        title={status?.message}
      >
        {badgeText}
      </span>

      <div className="flex-1" />

      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setSearchOpen(true)}
      >
        <Search className="w-3.5 h-3.5" />
        切换合约
        <kbd className="hidden sm:inline text-[10px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
          Ctrl+K
        </kbd>
      </Button>
    </div>
  )
}
