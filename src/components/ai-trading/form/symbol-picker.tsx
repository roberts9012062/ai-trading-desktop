"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  getContractsApi,
  getContractsByCodeApi,
  searchContractsApi,
  type ContractItem,
} from "@/lib/api"
import type { CodeTreeMap } from "@/types"
import { cn } from "@/lib/utils"

interface SymbolPickerProps {
  symbol: string
  symbolName: string
  onChange: (symbol: string, symbolName: string) => void
}

interface PickerItem extends ContractItem {
  is_master?: boolean
  is_secondary?: boolean
}

/** 合并全量列表与主力标记 */
function mergeMasterFlags(
  list: ContractItem[],
  tree: CodeTreeMap | null,
): PickerItem[] {
  if (!tree) return list
  const masterSet = new Set<string>()
  const secondarySet = new Set<string>()
  for (const node of Object.values(tree)) {
    if (node.master) masterSet.add(node.master.toLowerCase())
    if (node.secondary) secondarySet.add(node.secondary.toLowerCase())
  }
  return list.map((c) => ({
    ...c,
    is_master: masterSet.has(c.symbol.toLowerCase()),
    is_secondary: secondarySet.has(c.symbol.toLowerCase()),
  }))
}

/** 品种选择：下拉浏览 + 手动输入，二者并存 */
export function SymbolPicker({
  symbol,
  symbolName,
  onChange,
}: SymbolPickerProps): React.JSX.Element {
  const [allContracts, setAllContracts] = useState<PickerItem[]>([])
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchHits, setSearchHits] = useState<PickerItem[]>([])
  const rootRef = useRef<HTMLDivElement>(null)

  // 打开时懒加载全量合约 + 主力标记
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void Promise.all([
      getContractsApi().catch(() => [] as ContractItem[]),
      getContractsByCodeApi().catch(() => null as CodeTreeMap | null),
    ])
      .then(([list, tree]) => {
        if (cancelled) return
        const base = Array.isArray(list) ? list : []
        setAllContracts(mergeMasterFlags(base, tree))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  // 输入时远程搜索
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    const timer = setTimeout(() => {
      void searchContractsApi(q)
        .then((r) => {
          const hits = (r.contracts ?? []).map((c) => {
            const known = allContracts.find(
              (a) => a.symbol.toLowerCase() === c.symbol.toLowerCase(),
            )
            return {
              ...c,
              is_master: known?.is_master,
              is_secondary: known?.is_secondary,
            }
          })
          setSearchHits(hits)
        })
        .catch(() => setSearchHits([]))
    }, 200)
    return () => clearTimeout(timer)
  }, [query, allContracts])

  // 点击外部关闭
  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [])

  const displayList = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      const map = new Map<string, PickerItem>()
      for (const c of searchHits) map.set(c.symbol.toLowerCase(), c)
      for (const c of allContracts) {
        const key = c.symbol.toLowerCase()
        if (map.has(key)) continue
        if (
          key.includes(q) ||
          (c.name || "").toLowerCase().includes(q) ||
          (c.exchange || "").toLowerCase().includes(q)
        ) {
          map.set(key, c)
        }
      }
      return Array.from(map.values()).slice(0, 100)
    }
    // 无关键字：先主力，再全量
    const masters = allContracts.filter((c) => c.is_master)
    if (masters.length > 0) return masters
    return allContracts.slice(0, 120)
  }, [query, searchHits, allContracts])

  function selectContract(c: PickerItem): void {
    onChange(c.symbol, c.name || "")
    setQuery("")
    setOpen(false)
  }

  function handleInputChange(value: string): void {
    setQuery(value)
    // 手输时同步 symbol；若匹配到已知名称则带上
    const match = allContracts.find(
      (c) => c.symbol.toLowerCase() === value.trim().toLowerCase(),
    )
    onChange(value.trim(), match?.name || (value.trim() === symbol ? symbolName : ""))
    setOpen(true)
  }

  function clearSelection(): void {
    onChange("", "")
    setQuery("")
    setOpen(true)
  }

  return (
    <div ref={rootRef} className="space-y-1">
      <Label>品种</Label>
      <div className="relative">
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <Input
              className="pl-7 pr-8"
              value={query !== "" ? query : symbol}
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={() => { setQuery(""); setOpen(true) }}
              placeholder="输入代码/名称，或点右侧下拉"
              autoComplete="off"
            />
            {(symbol || query) && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={clearSelection}
                aria-label="清空"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            className={cn(
              "h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)]",
              "text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] shrink-0",
              "inline-flex items-center gap-1",
            )}
            onClick={() => { setQuery(""); setOpen((v) => !v) }}
          >
            下拉
            <ChevronDown
              className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")}
            />
          </button>
        </div>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg overflow-hidden">
            <div className="px-2 py-1.5 text-[10px] text-[var(--text-muted)] border-b border-[var(--border)] flex justify-between">
              <span>
                {query.trim()
                  ? `搜索「${query.trim()}」`
                  : "主力优先 · 可滚动浏览或输入过滤"}
              </span>
              <span>{loading ? "加载中…" : `${displayList.length} 条`}</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {displayList.length === 0 && !loading && (
                <p className="px-3 py-4 text-xs text-center text-[var(--text-muted)]">
                  {query.trim()
                    ? "无匹配项，仍可直接输入合约代码创建"
                    : "暂无合约数据"}
                </p>
              )}
              {displayList.map((c) => {
                const active = c.symbol.toLowerCase() === symbol.toLowerCase()
                return (
                  <button
                    key={c.symbol}
                    type="button"
                    className={cn(
                      "w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left",
                      "hover:bg-[var(--bg-tertiary)]",
                      active && "bg-[var(--primary)]/15 text-[var(--primary)]",
                    )}
                    onClick={() => selectContract(c)}
                  >
                    <span className="font-mono font-medium min-w-[72px]">
                      {c.symbol}
                    </span>
                    <span className="truncate text-[var(--text-secondary)] flex-1">
                      {c.name}
                    </span>
                    {c.is_master && (
                      <span className="text-[10px] px-1 rounded bg-red-500/20 text-red-400">
                        主
                      </span>
                    )}
                    {c.is_secondary && !c.is_master && (
                      <span className="text-[10px] px-1 rounded bg-orange-500/20 text-orange-400">
                        次
                      </span>
                    )}
                    {c.exchange && (
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {c.exchange}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            {symbol && (
              <div className="px-2.5 py-1.5 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)]">
                已选：
                <span className="text-[var(--text-primary)] font-mono ml-1">
                  {symbol}
                </span>
                {symbolName && <span className="ml-1">· {symbolName}</span>}
              </div>
            )}
          </div>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        支持下拉点选主力/合约，也支持直接输入代码（如 rb2605）
      </p>
    </div>
  )
}
