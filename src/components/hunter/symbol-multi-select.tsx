import { useRef, useState } from "react"
import * as Popover from "@radix-ui/react-popover"
import { ChevronDown, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { HunterSymbol } from "@/lib/hunter/api"

interface Props {
  id: string; label: string; value: string[]; options: HunterSymbol[];
  onChange: (value: string[]) => void; max: number; loading: boolean;
  error: string | null; onRetry: () => void; hint: string;
}

export function HunterSymbolMultiSelect({ id, label, value, options, onChange, max, loading, error, onRetry, hint }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const names = new Map(options.map(option => [option.symbol, option.name]))
  const filter = query.trim().toLowerCase()
  const visible = options.filter(option => option.symbol.includes(filter) || option.name.toLowerCase().includes(filter))
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) setQuery("") }}><div className="space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Popover.Trigger asChild><button type="button" id={id}
      className="flex w-full items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm">
      <span>{value.length ? "已选择 " + value.length + " 个币种" : "点击选择币种"}</span><ChevronDown size={16} aria-hidden="true" />
    </button></Popover.Trigger>
    {value.length > 0 && <div className="flex flex-wrap gap-1">
      {value.map(symbol => <button key={symbol} type="button" aria-label={"从" + label + "移除 " + (names.get(symbol) ?? symbol)}
        onClick={() => onChange(value.filter(item => item !== symbol))}
        className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-hover)]">
        {names.get(symbol) ?? symbol}<X size={12} aria-hidden="true" />
      </button>)}
    </div>}
    <Popover.Portal><Popover.Content aria-label={label + "币种选项"} align="start" sideOffset={4} collisionPadding={8}
      onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus() }}
      className="z-[60] w-[var(--radix-popover-trigger-width)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 space-y-2 shadow-xl">
      <Input ref={search} aria-label={"搜索" + label + "币种"} placeholder="搜索币种（可选）" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>已选 {value.length} / {max}</span>
        <Button type="button" size="sm" variant="ghost" disabled={!value.length} onClick={() => onChange([])}>清空{label}</Button>
      </div>
      {loading ? <p role="status" className="text-xs p-2">正在加载 OKX 币种…</p> : error ?
        <div role="alert" className="text-xs space-y-2"><p>{error}</p><Button type="button" size="sm" variant="outline" onClick={onRetry}>重新加载币种</Button></div> :
        <div className="max-h-48 overflow-y-auto overscroll-contain">
          {visible.map(option => <label key={option.symbol} className="flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-[var(--bg-hover)] cursor-pointer">
            <input type="checkbox" checked={value.includes(option.symbol)} disabled={!value.includes(option.symbol) && value.length >= max}
              onChange={event => onChange(event.target.checked ? [...value, option.symbol] : value.filter(item => item !== option.symbol))} />
            <span>{option.name}</span>
          </label>)}
          {!visible.length && <p className="text-xs p-2 text-[var(--text-muted)]">{options.length ? "没有匹配的币种" : "暂无可选择的 OKX 币种"}</p>}
        </div>}
      <Popover.Close asChild><Button type="button" size="sm" variant="outline" className="w-full">完成选择</Button></Popover.Close>
    </Popover.Content></Popover.Portal>
    <p className="text-xs text-[var(--text-muted)]">{hint}</p>
  </div></Popover.Root>
}
