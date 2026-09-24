"use client"

import { useState, useMemo, useEffect, useCallback } from "react"
import { searchContractsApi, getContractsApi, getWatchlistApi, addWatchlistApi, deleteWatchlistApi } from "@/lib/api"
import type { ContractItem, WatchlistItem } from "@/lib/api"
import { useMarketStore } from "@/stores/market"
import { cn, formatPrice } from "@/lib/utils"
import { useAppStore, migrateStaleContract, readMarketViewContract } from "@/stores/app"
import { broadcastContractChange } from "@/hooks/sync"
import { Input } from "@/components/ui/input"
import { Star } from "lucide-react"
import { ContractTree } from "./contract-tree"
import { getCurrentKlinePeriod } from "@/components/market/kline/current-period"
import { prefetchKlineHistory } from "@/components/market/kline/use-kline-history"

/** 视图模式:flat=扁平(自选/全部), tree=品种树(三级菜单) */
type ViewMode = "flat" | "tree"

/** 合约列表组件（左侧栏）—— 接入真实 API 和 WebSocket 实时行情 */
export function ContractList(): React.JSX.Element {
  const { activeContract, setActiveContract } = useAppStore()
  const quotes = useMarketStore((s) => s.quotes)
  const flashMap = useMarketStore((s) => s.flashMap)
  const initWebSocket = useMarketStore((s) => s.initWebSocket)
  const codeTree = useMarketStore((s) => s.codeTree)
  const fetchCodeTree = useMarketStore((s) => s.fetchCodeTree)

  const [viewMode, setViewMode] = useState<ViewMode>("flat")

  const [contracts, setContracts] = useState<ContractItem[]>([])
  const [search, setSearch] = useState("")
  /** symbol → watchlist item id，删除自选必须用后端 UUID，不能传 symbol */
  const [watchlistIds, setWatchlistIds] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  // 各分组展开/收起状态（默认全部展开）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // 初始化 WebSocket 和合约列表
  useEffect(() => {
    initWebSocket()

    async function loadContracts() {
      try {
        const data = await getContractsApi()
        setContracts(data)
      } catch {
        // API 不可用时保持空列表
      } finally {
        setLoading(false)
      }
    }
    loadContracts()
    // 加载合约树(三级菜单数据)；
    // 恢复行情页自己的合约记忆（与 AI 看盘等页面的全局合约隔离）；
    // 无记忆 → 首次访问用 RB 主力兜底
    fetchCodeTree().then(() => {
      const tree = useMarketStore.getState().codeTree
      // URL 深链（?symbol=）优先：SymbolFromQuery 已写入记忆并广播，
      // 这里不恢复旧记忆，否则会把深链合约覆盖回上次浏览的合约
      const urlSymbol = new URLSearchParams(window.location.search)
        .get("symbol")
        ?.trim()
      if (urlSymbol) return
      const saved = readMarketViewContract()
      if (saved && saved !== activeContract) {
        // 行情页自己的记忆同样要做过期迁移（旧记忆可能是已下市/出厂默认）
        const migrated = migrateStaleContract(saved, tree)
        setActiveContract(migrated)
        broadcastContractChange(migrated)
        return
      }
      if (saved) return
      // 无记忆：沿用全局合约（layout 启动时已迁移，这里幂等兜底）
      const current = useAppStore.getState().activeContract
      const migrated = migrateStaleContract(current, tree)
      if (migrated !== current) {
        setActiveContract(migrated)
        broadcastContractChange(migrated)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initWebSocket, fetchCodeTree, setActiveContract])

  // 加载自选列表
  useEffect(() => {
    async function loadWatchlist() {
      try {
        const items: WatchlistItem[] = await getWatchlistApi()
        setWatchlistIds(new Map(items.map((item) => [item.contract_symbol, item.id])))
      } catch {
        // 未登录或 API 不可用
      }
    }
    loadWatchlist()
  }, [])

  const toggleStar = useCallback(async (e: React.MouseEvent, symbol: string, name: string) => {
    e.stopPropagation()
    try {
      const existingId = watchlistIds.get(symbol)
      if (existingId !== undefined) {
        await deleteWatchlistApi(existingId)
        setWatchlistIds((prev) => {
          const next = new Map(prev)
          next.delete(symbol)
          return next
        })
      } else {
        const item = await addWatchlistApi(symbol, name)
        setWatchlistIds((prev) => new Map(prev).set(symbol, item.id))
      }
    } catch {
      // 忽略失败
    }
  }, [watchlistIds])

  const handleSelect = useCallback((symbol: string) => {
    setActiveContract(symbol)
    broadcastContractChange(symbol)
    // 立即预取当前周期（有缓存则秒开；无缓存与 K 线请求去重）
    const period = getCurrentKlinePeriod()
    prefetchKlineHistory([symbol], period)
  }, [setActiveContract])

  /** 鼠标悬停邻合约：空闲预取，切过去更顺 */
  const handleHoverPrefetch = useCallback((symbol: string) => {
    const period = getCurrentKlinePeriod()
    prefetchKlineHistory([symbol], period)
  }, [])

  // 切换分组展开/收起
  const toggleGroup = useCallback((label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }, [])

  // 搜索过滤 + 交易所分组
  const groupedContracts = useMemo(() => {
    let filtered = contracts
    if (search) {
      const s = search.toLowerCase()
      filtered = contracts.filter(
        (c) => c.symbol.toLowerCase().includes(s) || c.name.includes(search)
      )
    }

    const starGroup: ContractItem[] = []
    const groups: Record<string, ContractItem[]> = {}

    for (const c of filtered) {
      if (watchlistIds.has(c.symbol)) {
        starGroup.push(c)
      } else {
        const list = groups[c.exchange] ?? []
        list.push(c)
        groups[c.exchange] = list
      }
    }

    const result: { label: string; items: ContractItem[] }[] = []
    if (starGroup.length > 0) result.push({ label: "★ 自选", items: starGroup })
    for (const [exchange, items] of Object.entries(groups)) {
      result.push({ label: exchange, items })
    }
    return result
  }, [contracts, search, watchlistIds])

  return (
    <div className="flex flex-col h-full">
      {/* 视图切换:扁平 / 品种树 */}
      <div className="flex border-b border-[var(--border)] bg-[var(--bg-tertiary)]">
        <button
          onClick={() => setViewMode("flat")}
          className={cn(
            "flex-1 px-2 py-1 text-[11px] cursor-pointer transition-colors",
            viewMode === "flat"
              ? "bg-[var(--bg-secondary)] text-[var(--primary)] font-bold"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
        >
          自选/全部
        </button>
        <button
          onClick={() => setViewMode("tree")}
          className={cn(
            "flex-1 px-2 py-1 text-[11px] cursor-pointer transition-colors",
            viewMode === "tree"
              ? "bg-[var(--bg-secondary)] text-[var(--primary)] font-bold"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
        >
          品种树
        </button>
      </div>

      {/* 品种树视图(三级菜单) */}
      {viewMode === "tree" ? (
        <div className="flex-1 min-h-0">
          {codeTree ? (
            <ContractTree
              data={codeTree}
              activeContract={activeContract}
              onSelect={handleSelect}
            />
          ) : (
            <div className="p-4 text-center text-xs text-[var(--text-muted)]">
              加载中...
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 搜索框(仅 flat 模式) */}
          <div className="p-2 border-b border-[var(--border)]">
            <Input
              placeholder="搜索合约"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          {/* 合约列表(flat 模式) */}
          <div className="flex-1 overflow-auto">
            {groupedContracts.map((group) => {
          const isCollapsed = collapsedGroups.has(group.label)
          // 收起时，若当前选中品种在该分组内，显示品种名称
          const activeInGroup = isCollapsed && activeContract
            ? group.items.some((c) => c.symbol === activeContract)
            : false
          const activeContractName = activeInGroup
            ? group.items.find((c) => c.symbol === activeContract)?.name
            : null

          return (
            <div key={group.label}>
              <div
                className="px-3 py-1 text-[10px] font-medium text-[var(--text-muted)] bg-[var(--bg-tertiary)] sticky top-0 cursor-pointer select-none flex items-center gap-1 hover:bg-[var(--bg-secondary)]"
                onClick={() => toggleGroup(group.label)}
              >
                <span className="text-[8px]">{isCollapsed ? "▶" : "▼"}</span>
                <span>{group.label}</span>
                {activeContractName && (
                  <span className="text-[var(--primary)] ml-1">{activeContractName}</span>
                )}
              </div>
              {!isCollapsed && group.items.map((c) => {
              const isActive = activeContract === c.symbol
              const quote = quotes[c.symbol]
              const isUp = quote ? quote.change >= 0 : true
              const flash = flashMap[c.symbol]

              return (
                <button
                  key={c.symbol}
                  onClick={() => handleSelect(c.symbol)}
                  onMouseEnter={() => handleHoverPrefetch(c.symbol)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-1.5 cursor-pointer relative",
                    isActive ? "bg-[var(--primary)]/10" : "hover:bg-[var(--bg-tertiary)]",
                  )}
                >
                  {/* 价格变动闪烁遮罩 */}
                  {flash && (
                    <span
                      key={flash.seq}
                      className={cn(
                        "absolute inset-0 pointer-events-none",
                        flash.direction === "up" ? "flash-up" : "flash-down"
                      )}
                    />
                  )}
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Star
                      size={12}
                      className={cn(
                        "shrink-0 cursor-pointer",
                        watchlistIds.has(c.symbol)
                          ? "fill-[var(--accent-warn)] text-[var(--accent-warn)]"
                          : "text-[var(--text-muted)]"
                      )}
                      onClick={(e) => toggleStar(e, c.symbol, c.name)}
                    />
                    <div>
                      <div className={cn("text-xs font-medium", isActive ? "text-[var(--primary)]" : "text-[var(--text-primary)]")}>
                        {c.symbol}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">{c.name}</div>
                    </div>
                  </div>
                  {quote && (
                    <div className="text-right">
                      <div className={cn("font-num text-xs font-medium", isUp ? "text-up" : "text-down")}>
                        {formatPrice(quote.last_price, quote.decimal_places)}
                      </div>
                      <div className={cn("font-num text-[10px]", isUp ? "text-up" : "text-down")}>
                        {isUp ? "+" : ""}{quote.change_pct.toFixed(2)}%
                      </div>
                    </div>
                  )}
                </button>
              )
            })}
            </div>
          )
        })}
        {groupedContracts.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">
            {search ? "未找到匹配的合约" : "暂无合约数据"}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
