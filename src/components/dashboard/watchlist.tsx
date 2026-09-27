"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { getWatchlistApi, deleteWatchlistApi } from "@/lib/api"
import type { WatchlistItem } from "@/lib/api"
import { useMarketStore } from "@/stores/market"
import { cn, formatPrice } from "@/lib/utils"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { useAppStore } from "@/stores/app"
import { X } from "lucide-react"

/** 自选行情列表（工作台版）—— 接入真实 API 和 WebSocket 实时行情 */
export function WatchlistTable(): React.JSX.Element {
  const router = useRouter()
  const { setActiveContract } = useAppStore()
  const { quotes, initWebSocket } = useMarketStore()
  const watchlistVersion = useAppStore((s) => s.watchlistVersion)

  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  // 初始化 WebSocket
  useEffect(() => {
    initWebSocket()
  }, [initWebSocket])

  // 加载自选列表
  useEffect(() => {
    async function loadWatchlist() {
      try {
        const items = await getWatchlistApi()
        setWatchlist(items)
        setLoadError(null)
      } catch (e) {
        // 未登录或服务不可达:区分"空列表"与"加载失败",便于排查环境问题
        setLoadError(e instanceof Error ? e.message : "自选服务不可达")
      } finally {
        setLoading(false)
      }
    }
    loadWatchlist()
  }, [watchlistVersion])

  function handleDoubleClick(symbol: string): void {
    setActiveContract(symbol)
    router.push(`/market?symbol=${encodeURIComponent(symbol)}`)
  }

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      if (confirmDelete !== id) {
        // 第一次点击：进入确认状态，3 秒后自动重置
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
        setConfirmDelete(id)
        confirmTimerRef.current = setTimeout(() => setConfirmDelete(null), 3000)
        return
      }
      // 第二次点击：执行删除
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      try {
        await deleteWatchlistApi(id)
        setWatchlist((prev) => prev.filter((item) => item.id !== id))
      } catch {
        // 删除失败静默处理
      }
      setConfirmDelete(null)
    },
    [confirmDelete],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-[var(--text-muted)]">
        加载中...
      </div>
    )
  }

  if (watchlist.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          {loadError ? `自选加载失败：${loadError}` : "暂无自选合约"}
        </p>
        {!loadError && (
        <p className="text-[10px] text-[var(--text-muted)]">到行情页点☆添加，双击行可直接跳转</p>
        )}
        {!loadError && (
        <button
          onClick={() => router.push("/market")}
          className="text-xs text-[var(--primary)] hover:underline cursor-pointer"
        >
          前往行情页添加自选合约 →
        </button>
        )}
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>合约</TableHead>
          <TableHead>最新价</TableHead>
          <TableHead>涨跌幅</TableHead>
          <TableHead className="hidden md:table-cell">买一</TableHead>
          <TableHead className="hidden md:table-cell">卖一</TableHead>
          <TableHead className="w-8"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {watchlist.map((item) => {
          // 优先使用 WebSocket 实时行情，其次使用 API 返回的行情
          // (quotes 键已统一小写;contract_symbol 兜底小写防历史数据大小写不一)
          const wsQuote = quotes[item.contract_symbol] ?? quotes[item.contract_symbol.toLowerCase()]
          const lastPrice = wsQuote?.last_price ?? item.last_price
          const change = wsQuote?.change ?? item.change
          const changePct = wsQuote?.change_pct ?? item.change_pct
          const bidPrice = wsQuote?.bid_price ?? item.bid_price
          const askPrice = wsQuote?.ask_price ?? item.ask_price

          const isUp = (change ?? 0) >= 0
          const isDeleting = confirmDelete === item.id

          return (
            <TableRow
              key={item.id}
              className="cursor-pointer group"
              onDoubleClick={() => handleDoubleClick(item.contract_symbol)}
            >
              <TableCell>
                <div className="text-sm font-medium text-[var(--text-primary)]">{item.contract_symbol}</div>
                <div className="text-[10px] text-[var(--text-muted)]">{item.contract_name}</div>
              </TableCell>
              <TableCell>
                <span className={cn("font-num text-sm", isUp ? "text-up" : "text-down")}>
                  {lastPrice != null ? formatPrice(lastPrice) : "--"}
                </span>
              </TableCell>
              <TableCell>
                <span className={cn("font-num text-sm", isUp ? "text-up" : "text-down")}>
                  {changePct != null ? `${isUp ? "+" : ""}${changePct.toFixed(2)}%` : "--"}
                </span>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="font-num text-sm text-up">
                  {bidPrice != null ? formatPrice(bidPrice) : "--"}
                </span>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="font-num text-sm text-down">
                  {askPrice != null ? formatPrice(askPrice) : "--"}
                </span>
              </TableCell>
              <TableCell>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(item.id)
                  }}
                  className={cn(
                    "opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-0.5 rounded",
                    isDeleting ? "opacity-100 text-[var(--accent-danger)]" : "text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                  )}
                  title={isDeleting ? "再次点击确认删除" : "删除"}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
