"use client"

/**
 * 合约下拉选择 —— 可选现有合约，也可手动输入任意 symbol
 */

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { getContractsApi, type ContractItem } from "@/lib/api"

interface SymbolComboboxProps {
  value: string
  onChange: (symbol: string) => void
  contracts: ContractItem[]
}

const MAX_OPTIONS = 60

/** 合约组合框：输入过滤 + 下拉选择 + 允许手动输入 */
export function SymbolCombobox({
  value,
  onChange,
  contracts,
}: SymbolComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const [filter, setFilter] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const [freshContracts, setFreshContracts] = useState<ContractItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void getContractsApi().then(list => { if (!cancelled) setFreshContracts(list) }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    setQuery(value)
  }, [value])

  // 点击外部关闭下拉
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [])

  function openList(): void {
    setFilter("")
    setOpen(true)
  }

  const q = filter.trim().toLowerCase()
  const available = freshContracts ?? contracts
  const filtered = (
    q === ""
      ? available
      : available.filter(
          (c) =>
            c.symbol.toLowerCase().includes(q) || c.name.includes(filter.trim()),
        )
  ).slice(0, MAX_OPTIONS)

  return (
    <div ref={ref} className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setFilter(e.target.value)
          onChange(e.target.value.trim())
          setOpen(true)
        }}
        onFocus={openList}
        placeholder="搜索或输入合约，如 rb2610"
        className="w-full h-9 px-3 pr-8 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
      />
      <button type="button" aria-label="选择合约币种" aria-expanded={open} onClick={() => open ? setOpen(false) : openList()} className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)]"><ChevronDown className="w-4 h-4" /></button>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg">
          {loading && <p role="status" className="px-3 py-2 text-xs">正在刷新合约…</p>}
          {!loading && !filtered.length && <p className="px-3 py-2 text-xs">{q ? "没有匹配合约" : "暂无合约，重新打开可重试"}</p>}
          {filtered.map((c) => (
            <button
              key={c.symbol}
              type="button"
              onClick={() => {
                onChange(c.symbol)
                setQuery(c.symbol)
                setOpen(false)
              }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] flex items-center justify-between gap-2"
            >
              <span className="font-num text-[var(--text-primary)]">
                {c.symbol}
              </span>
              <span className="text-[var(--text-muted)] truncate">
                {c.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
