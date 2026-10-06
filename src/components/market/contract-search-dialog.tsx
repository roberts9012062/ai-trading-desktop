"use client"

import { useState, useEffect, useRef } from "react"
import { Search, Star, Plus, X } from "lucide-react"
import { useAppStore } from "@/stores/app"
import { getContractsApi, searchContractsApi, addWatchlistApi } from "@/lib/api"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ContractItem } from "@/lib/api"

/** 合约搜索弹窗 —— Ctrl+K 或点击搜索按钮触发 */
export function ContractSearchDialog(): React.JSX.Element {
  const { searchOpen, setSearchOpen } = useAppStore()
  const bumpWatchlistVersion = useAppStore((s) => s.bumpWatchlistVersion)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<ContractItem[]>([])
  const [loading, setLoading] = useState(false)
  const [addedSymbols, setAddedSymbols] = useState<Set<string>>(new Set())
  const [addingSymbol, setAddingSymbol] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 弹窗打开时自动聚焦输入框
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
    } else {
      setQuery("")
      setResults([])
      setAddedSymbols(new Set())
    }
  }, [searchOpen])

  // 打开即可浏览，输入时过滤；关闭或新查询使旧响应失效。
  useEffect(() => {
    if (!searchOpen) return
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      const request = query.trim()
        ? searchContractsApi(query.trim()).then(result => result.contracts)
        : getContractsApi()
      void request.then(list => { if (!cancelled) setResults(list) })
        .catch(() => { if (!cancelled) setResults([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, query.trim() ? 300 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [searchOpen, query])

  function handleInputChange(value: string) {
    setQuery(value)
  }

  async function handleAddToWatchlist(symbol: string, name: string) {
    if (addedSymbols.has(symbol) || addingSymbol !== null) return
    setAddingSymbol(symbol)
    try {
      await addWatchlistApi(symbol, name)
      setAddedSymbols((prev) => new Set(prev).add(symbol))
      bumpWatchlistVersion()
    } catch {
      // 添加失败不提示，静默处理
    } finally {
      setAddingSymbol(null)
    }
  }

  function handleClose() {
    setSearchOpen(false)
  }

  return (
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
      <DialogContent className="sm:max-w-[520px] p-0 gap-0 overflow-hidden">
        {/* 搜索输入区域 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="输入合约代码或名称搜索，如 rb、螺纹钢"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          {query.length > 0 && (
            <button
              onClick={() => { setQuery(""); setResults([]) }}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
          )}
          <kbd className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-muted)]">
            ESC
          </kbd>
        </div>

        {/* 搜索结果列表 */}
        <ScrollArea className="max-h-[360px]">
          {loading && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              搜索中...
            </div>
          )}

          {!loading && query.trim().length > 0 && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              未找到匹配的合约
            </div>
          )}

          {!loading && query.trim().length === 0 && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              暂无合约数据，重新打开可重试
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="py-1">
              {results.map((contract) => {
                const isAdded = addedSymbols.has(contract.symbol)
                const isAdding = addingSymbol === contract.symbol
                return (
                  <div
                    key={contract.symbol}
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--bg-tertiary)] cursor-pointer group"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {contract.symbol}
                      </span>
                      <span className="text-sm text-[var(--text-secondary)]">
                        {contract.name}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]">
                        {contract.exchange}
                      </span>
                    </div>
                    <button
                      onClick={() => handleAddToWatchlist(contract.symbol, contract.name)}
                      disabled={isAdded || isAdding}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors cursor-pointer ${
                        isAdded
                          ? "text-[var(--accent-down)] bg-[var(--accent-down)]/10"
                          : "text-[var(--text-muted)] hover:text-[var(--primary)] hover:bg-[var(--primary)]/10 opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      {isAdding ? (
                        "添加中..."
                      ) : isAdded ? (
                        <>
                          <Star className="w-3.5 h-3.5 fill-current" />
                          已添加
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5" />
                          加自选
                        </>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
