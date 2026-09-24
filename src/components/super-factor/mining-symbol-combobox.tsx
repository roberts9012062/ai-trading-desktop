"use client"

/**
 * 超级因子挖掘 —— 可挖掘品种下拉
 * 数据源：/api/factor-mining/symbols（PG 中有日线历史的品种）
 * 选项为主力合约格式（如 rb2701），与因子实验室品种选项同口径，
 * 收藏后到创建任务表单能自动选上正确品种
 */

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { fetchMiningSymbols, type MiningSymbol } from "@/lib/super-factor-api"

interface Props {
  value: string
  onChange: (code: string) => void
}

const MAX_OPTIONS = 80

export function MiningSymbolCombobox({ value, onChange }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const [symbols, setSymbols] = useState<MiningSymbol[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  // 加载可挖掘品种列表（PG 有历史的品种）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const list = await fetchMiningSymbols()
        if (!cancelled) setSymbols(list)
      } catch {
        if (!cancelled) setSymbols([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 点击外部关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [])

  // 选项值：优先主力合约符号（rb2701，与因子实验室同口径），无映射回退品种 code
  const optionValue = (s: MiningSymbol): string => s.symbol ?? s.code
  const optionName = (s: MiningSymbol): string => s.symbol_name ?? s.name

  const q = query.trim().toLowerCase()
  const filtered = (
    q === ""
      ? symbols
      : symbols.filter(
          (s) =>
            optionValue(s).toLowerCase().includes(q) ||
            optionName(s).includes(query.trim()) ||
            s.code.toLowerCase().includes(q) ||
            s.name.includes(query.trim()),
        )
  ).slice(0, MAX_OPTIONS)

  return (
    <div ref={ref} className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          onChange(e.target.value.trim().toLowerCase())
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder={
          loading
            ? "加载可挖掘品种…"
            : symbols.length === 0
              ? "暂无可挖掘品种（需先导入历史）"
              : "搜索合约，如 rb2701 / 螺纹钢"
        }
        className="w-full h-9 px-3 pr-8 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
      />
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none" />

      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg">
          {filtered.map((s) => (
            <button
              key={s.code}
              type="button"
              onClick={() => {
                onChange(optionValue(s))
                setQuery(optionValue(s))
                setOpen(false)
              }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="font-num text-[var(--text-primary)] shrink-0">
                  {optionValue(s)}
                </span>
                <span className="text-[var(--text-muted)] truncate">
                  {optionName(s)}
                </span>
              </span>
              <span className="text-[10px] text-[var(--text-muted)] font-num shrink-0">
                {s.bars}根
              </span>
            </button>
          ))}
        </div>
      )}
      {open && !loading && filtered.length === 0 && symbols.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg px-3 py-2 text-xs text-[var(--text-muted)]">
          无匹配品种
        </div>
      )}
    </div>
  )
}
