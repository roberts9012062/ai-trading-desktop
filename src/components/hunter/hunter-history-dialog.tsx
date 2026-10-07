"use client"

/**
 * 猎手交易历史：列出该猎手最近 100 笔已结束机会（已平仓/未成交），
 * 点击任意一笔回看当次的 K 线信号图与计划详情。
 */

import { useMemo, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { Hunter, Opportunity } from "@/lib/hunter/api"
import { hunterCycleLabel } from "@/lib/hunter/macd-ma20"

const money = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtTime = (iso?: string | null) => iso ? new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z").toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"

export function HunterHistoryDialog({ group, onSelect, onClose }: {
  group: Hunter; onSelect: (o: Opportunity) => void; onClose: () => void
}) {
  const [onlyFilled, setOnlyFilled] = useState(true)
  const rows = useMemo(() => group.opportunities
    .filter(o => o.finished_at)
    .filter(o => !onlyFilled || Boolean(o.runtime.initial_qty))
    .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? "")).reverse(),
    [group.opportunities, onlyFilled])
  const filled = rows.filter(o => (o.runtime.initial_qty ?? 0) > 0)
  const wins = filled.filter(o => o.net_profit > 0).length
  const closedPnl = filled.reduce((s, o) => s + o.net_profit, 0)
  return <Dialog open onOpenChange={v => { if (!v) onClose() }}>
    <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{group.name} · 交易历史（最近 100 笔）</DialogTitle>
        <DialogDescription>点击任意一笔回看当次的 K 线信号图、入场/止损计划与离场原因。</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs" aria-label="历史统计">
        <span>已平仓 <strong>{filled.length}</strong> 笔{filled.length ? <> · 胜率 <strong>{(wins/filled.length*100).toFixed(0)}%</strong> · 累计净盈亏 <strong className={closedPnl >= 0 ? "text-red-400" : "text-emerald-400"}>{money(closedPnl)} USDT</strong></> : null}</span>
        <label className="flex items-center gap-1"><input type="checkbox" checked={!onlyFilled} onChange={e => setOnlyFilled(!e.target.checked)} />含未成交挂载（{group.opportunities.filter(o => o.finished_at && !o.runtime.initial_qty).length} 笔）</label>
      </div>
      {rows.length === 0 ? <p className="text-xs text-[var(--text-muted)]">暂无历史记录。</p> : <div className="overflow-x-auto mt-2">
        <table className="w-full text-xs text-left">
          <thead><tr className="text-[var(--text-muted)]">
            <th className="p-2">结束时间</th><th>币种 / 周期 / 方向</th><th>状态</th><th>入场 / 止损</th><th>净盈亏</th><th>离场原因</th><th></th>
          </tr></thead>
          <tbody>{rows.map(o => <tr key={o.id} className="border-t border-[var(--border)]">
            <td className="p-2 whitespace-nowrap">{fmtTime(o.finished_at)}</td>
            <td className="whitespace-nowrap">{o.symbol.toUpperCase()} · {hunterCycleLabel(o.cycle)} · {o.plan.direction === "long" ? "多" : "空"}</td>
            <td>{(o.runtime.initial_qty ?? 0) > 0 ? "已平仓" : "未成交"}</td>
            <td className="whitespace-nowrap font-num">{o.runtime.entry != null ? o.runtime.entry.toPrecision(7) : o.plan.entry.toPrecision(7)} / {typeof (o.runtime.stop ?? o.plan.stop) === "number" ? (o.runtime.stop ?? o.plan.stop)!.toPrecision(7) : "无"}</td>
            <td className={"font-num " + (o.net_profit > 0 ? "text-red-400" : o.net_profit < 0 ? "text-emerald-400" : "")}>{(o.runtime.initial_qty ?? 0) > 0 ? money(o.net_profit) : "—"}</td>
            <td className="max-w-[18rem] truncate" title={o.runtime.reason ?? o.runtime.note ?? ""}>{o.runtime.reason ?? o.runtime.note ?? "—"}</td>
            <td><Button size="sm" variant="outline" onClick={() => onSelect(o)}>回看信号</Button></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </DialogContent>
  </Dialog>
}
