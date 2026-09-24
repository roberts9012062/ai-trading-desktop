"use client"

/**
 * 交易页顶栏 —— 当前合约信息 + 交易所切换（实盘）+ 切换入口
 *
 * 实盘模式：OKX / Binance(币安) / Gate(芝麻开门) 三所对等切换；
 * 虚拟盘模式：模拟撮合，不显示交易所选择。
 */

import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { useSessionStatus } from "@/hooks/use-session-status"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { VENUES } from "@/lib/live-api"
import { Button } from "@/components/ui/button"
import { Search } from "lucide-react"

/** 交易所切换器（仅实盘模式显示） */
function VenueSwitcher(): React.JSX.Element | null {
  const mode = usePaperTradingStore((s) => s.mode)
  const venue = usePaperTradingStore((s) => s.venue)
  const setVenue = usePaperTradingStore((s) => s.setVenue)
  if (mode !== "live") return null
  return (
    <div
      className="flex items-center rounded-md border border-[var(--border)] overflow-hidden shrink-0"
      role="group"
      aria-label="交易所切换"
    >
      {VENUES.map((v) => (
        <button
          key={v.venue}
          type="button"
          onClick={() => setVenue(v.venue)}
          className={cn(
            "px-2 h-6 text-[11px] font-medium transition-colors",
            venue === v.venue
              ? "bg-[var(--primary)] text-white"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          )}
          title={v.name}
        >
          {v.short}
        </button>
      ))}
    </div>
  )
}

/** 交易页合约条 */
export function TradingHeader(): React.JSX.Element {
  const activeContract = useAppStore((s) => s.activeContract)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const quote = useMarketStore((s) => s.quotes[activeContract])
  const tradingMode = usePaperTradingStore((s) => s.mode)
  const venue = usePaperTradingStore((s) => s.venue)
  const { isOpen, status, hasVirtualQuote } = useSessionStatus(activeContract)
  const isVirtual = tradingMode === "virtual" || status?.trading_mode === "virtual"

  const name = quote?.name ?? activeContract
  const last = quote?.last_price
  const change = quote?.change ?? 0
  const changePct = quote?.change_pct ?? 0
  const decimals = quote?.decimal_places ?? 2
  const up = change >= 0

  /** 状态徽章：加密货币 7×24；virtual 为模拟撮合 */
  let badgeText = isOpen ? "实盘·7×24" : "休市"
  let badgeWarn = !isOpen
  if (isVirtual) {
    if (hasVirtualQuote === false && last == null) {
      badgeText = "暂无行情"
      badgeWarn = true
    } else if (hasVirtualQuote === false) {
      badgeText = "虚拟·待源"
      badgeWarn = true
    } else {
      badgeText = "虚拟盘·7×24"
      badgeWarn = false
    }
  } else {
    const short = VENUES.find((v) => v.venue === venue)?.short ?? ""
    badgeText = `实盘·${short}·7×24`
    badgeWarn = false
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

      <VenueSwitcher />

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
