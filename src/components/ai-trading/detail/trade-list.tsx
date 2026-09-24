"use client"

import {
  isBullishActionLabel,
  paperActionLabel,
} from "@/lib/trade-labels"
import { cn, formatDisplayTime } from "@/lib/utils"

interface TradeListProps {
  items: Record<string, unknown>[]
  loading: boolean
  /** 是否显示手续费列（默认显示；AI 看盘页传 false 精简） */
  showFee?: boolean
  /** 是否显示状态列（默认显示；AI 看盘页传 false 精简） */
  showStatus?: boolean
}

/** 交易记录列表（paper 委托） */
export function TradeList({
  items,
  loading,
  showFee = true,
  showStatus = true,
}: TradeListProps): React.JSX.Element {
  if (loading) {
    return (
      <p className="text-xs text-[var(--text-muted)] py-6 text-center">加载中…</p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)] py-6 text-center">
        暂无交易记录
      </p>
    )
  }
  return (
    <div className="overflow-x-auto max-h-[360px]">
      <table className="w-full text-xs">
        <thead className="text-[var(--text-muted)]">
          <tr className="border-b border-[var(--border)]">
            <th className="text-left py-2 font-normal">时间</th>
            <th className="text-left py-2 font-normal">方向</th>
            <th className="text-right py-2 font-normal">成交价</th>
            <th className="text-right py-2 font-normal">手数</th>
            {showFee && <th className="text-right py-2 font-normal">手续费</th>}
            {showStatus && <th className="text-right py-2 font-normal">状态</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((row) => {
            const id = String(row.id ?? "")
            const dir = String(row.direction ?? "")
            const offset = String(row.offset ?? "")
            const price = Number(row.price ?? 0)
            const qty = Number(row.filled_qty ?? row.quantity ?? 0)
            const fee = Number(row.fee ?? 0)
            const status = String(row.status ?? "")
            const time = String(row.filled_at || row.created_at || "")
            const label = paperActionLabel(dir, offset)
            return (
              <tr key={id} className="border-b border-[var(--border)]/50">
                <td className="py-2 text-[var(--text-muted)] whitespace-nowrap">
                  {formatDisplayTime(time)}
                </td>
                <td
                  className={cn(
                    "py-2",
                    isBullishActionLabel(label) ? "text-up" : "text-down",
                  )}
                >
                  {label}
                </td>
                <td className="py-2 text-right font-num">{price}</td>
                <td className="py-2 text-right font-num">{qty}</td>
                {showFee && (
                  <td className="py-2 text-right font-num text-[var(--text-muted)]">
                    {fee > 0 ? fee.toFixed(2) : "—"}
                  </td>
                )}
                {showStatus && (
                  <td className="py-2 text-right text-[var(--text-secondary)]">
                    {status}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
