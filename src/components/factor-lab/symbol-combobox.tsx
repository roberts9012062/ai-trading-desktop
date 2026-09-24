"use client"

/**
 * 合约下拉选择 —— 可选现有合约，也可手动输入任意 symbol
 */

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { ContractItem } from "@/lib/api"

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
  const ref = useRef<HTMLDivElement>(null)

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

  const q = query.trim().toLowerCase()
  const filtered = (
    q === ""
      ? contracts
      : contracts.filter(
          (c) =>
            c.symbol.toLowerCase().includes(q) || c.name.includes(query.trim()),
        )
  ).slice(0, MAX_OPTIONS)

  return (
    <div ref={ref} className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          onChange(e.target.value.trim())
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder="搜索或输入合约，如 rb2610"
        className="w-full h-9 px-3 pr-8 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
      />
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none" />

      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg">
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
