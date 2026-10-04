"use client"

/**
 * 主播持仓录入卡片 —— 手动填写开仓价/方向/手数，或从模拟盘一键带入
 *
 * 填写后主播每轮播报汇报持仓状态（开仓价/浮动盈亏）并给持仓操作建议；
 * 未填写或清除后恢复普通播报，行为与从前完全一致。
 */

import { NumericInput } from "@/components/ui/numeric-input"
import { withNumericValidation } from "@/lib/numeric-input"
import { useState } from "react"
import { ChevronDown, ChevronRight, Wallet } from "lucide-react"
import { getPaperPositions } from "@/lib/paper-api"
import { useAiAnchorStore } from "@/stores/ai-anchor"

export function AnchorPositionCard(): React.JSX.Element {
  const task = useAiAnchorStore((s) => s.task)
  const acting = useAiAnchorStore((s) => s.acting)
  const savePosition = useAiAnchorStore((s) => s.savePosition)
  const clearPosition = useAiAnchorStore((s) => s.clearPosition)

  const saved = task?.manual_position ?? null
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState("")
  const [direction, setDirection] = useState<"long" | "short">("long")
  const [priceText, setPriceText] = useState("")
  const [qtyText, setQtyText] = useState("")
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const openForm = () => {
    const cur = task?.manual_position
    setSymbol(cur?.symbol ?? task?.symbol ?? "")
    setDirection(cur?.direction ?? "long")
    setPriceText(cur ? String(cur.price) : "")
    setQtyText(cur ? String(cur.quantity) : "")
    setLocalError(null)
    setOpen(true)
  }

  const handleSave = async () => {
    const price = Number(priceText)
    const quantity = Number(qtyText)
    const sym = symbol.trim().toLowerCase()
    if (!sym) {
      setLocalError("请填写合约代码")
      return
    }
    if (!Number.isFinite(price) || price <= 0) {
      setLocalError("请填写有效开仓价")
      return
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setLocalError("请填写有效手数")
      return
    }
    setBusy(true)
    setLocalError(null)
    const ok = await savePosition({ symbol: sym, direction, price, quantity })
    setBusy(false)
    if (ok) setOpen(false)
  }

  const importFromPaper = async () => {
    setBusy(true)
    setLocalError(null)
    try {
      const data = await getPaperPositions()
      const items = data.items ?? []
      if (items.length === 0) {
        setLocalError("模拟盘暂无持仓")
      } else {
        // 优先带入与主播看盘合约相同的一条，否则第一条
        const target =
          items.find((i) => i.symbol.toLowerCase() === task?.symbol) ?? items[0]
        setSymbol(target.symbol.toLowerCase())
        setDirection(target.direction === "short" ? "short" : "long")
        setPriceText(String(target.avg_price))
        setQtyText(String(target.quantity))
      }
    } catch {
      setLocalError("读取模拟盘持仓失败")
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    setBusy(true)
    await clearPosition()
    setBusy(false)
    setOpen(false)
  }

  return (
    <div className="rounded-lg border border-[var(--border)]">
      {/* 收起态：一行摘要 + 展开箭头 */}
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openForm())}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left cursor-pointer hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
      >
        <Wallet className="w-3.5 h-3.5 shrink-0 text-[var(--primary)]" />
        <span className="text-[11px] font-bold shrink-0">我的持仓</span>
        <span className="min-w-0 flex-1 truncate text-[10px] font-num text-[var(--text-secondary)]">
          {saved
            ? `${saved.direction === "long" ? "多" : "空"} ${saved.symbol.toUpperCase()} @${saved.price} ×${saved.quantity}手`
            : "未填写 · 普通播报"}
        </span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
        )}
      </button>

      {/* 展开态：录入表单 */}
      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t border-[var(--border)] pt-2">
          <div className="text-[10px] text-[var(--text-muted)]">
            填写后主播将汇报持仓状态并给持仓操作建议
          </div>

          <div className="flex items-center gap-1.5">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="合约，如 rb2610"
              className="flex-1 min-w-0 h-7 px-2 rounded text-[11px] font-num bg-[var(--bg-secondary)] border border-[var(--border)] outline-none focus:border-[var(--primary)]"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void importFromPaper()}
              className="h-7 px-2 rounded text-[10px] border border-[var(--primary)]/50 text-[var(--primary)] hover:bg-[var(--primary)]/10 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              模拟盘带入
            </button>
          </div>

          {/* 多/空切换 */}
          <div className="flex gap-1.5">
            {(
              [
                { value: "long", label: "做多", active: "border-red-500/60 bg-red-500/10 text-red-400" },
                { value: "short", label: "做空", active: "border-green-500/60 bg-green-500/10 text-green-400" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDirection(opt.value)}
                className={
                  "flex-1 h-7 rounded text-[11px] border cursor-pointer transition-colors " +
                  (direction === opt.value
                    ? opt.active
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex gap-1.5">
            <NumericInput type="number"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              inputMode="decimal"
              placeholder="开仓价"
              className="flex-1 min-w-0 h-7 px-2 rounded text-[11px] font-num bg-[var(--bg-secondary)] border border-[var(--border)] outline-none focus:border-[var(--primary)]"
            />
            <NumericInput type="number"
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              inputMode="decimal"
              placeholder="手数"
              className="w-20 h-7 px-2 rounded text-[11px] font-num bg-[var(--bg-secondary)] border border-[var(--border)] outline-none focus:border-[var(--primary)]"
            />
          </div>

          {localError && <div className="text-[10px] text-red-400">{localError}</div>}

          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy || acting}
              onClick={withNumericValidation(() => void handleSave())}
              className="flex-1 h-7 rounded text-[11px] bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            {saved && (
              <button
                type="button"
                disabled={busy || acting}
                onClick={() => void handleClear()}
                className="h-7 px-2.5 rounded text-[11px] border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50 cursor-pointer"
              >
                清除持仓
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
