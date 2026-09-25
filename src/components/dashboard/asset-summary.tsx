"use client"

import { usePaperTradingStore } from "@/stores/paper-trading"
import { cn } from "@/lib/utils"

/** 格式化金额 */
function formatMoney(value: number): string {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 实时资产摘要条 —— 双模式统一入口(live=交易所真实账户聚合,virtual=模拟账本)。
 *  旧版直连 /api/paper/account:纯实盘环境下模拟账本恒空,五项全部 0.00。
 *  数据随工作台页 15s 轮询的 store.refresh 保持新鲜。 */
export function AssetSummaryBar(): React.JSX.Element {
  const account = usePaperTradingStore((s) => s.account)
  const error = usePaperTradingStore((s) => s.error)
  const mode = usePaperTradingStore((s) => s.mode)

  if (error && !account) {
    return (
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-muted)]">
        资产：{error}
      </div>
    )
  }

  if (!account) {
    return (
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-muted)]">
        资产加载中…
      </div>
    )
  }

  const items = [
    {
      label: "总权益",
      value: formatMoney(account.total_equity),
      color: "text-[var(--text-primary)]",
    },
    {
      label: "可用保证金",
      value: formatMoney(account.available_margin),
      color: "text-[var(--text-primary)]",
    },
    {
      label: "浮动盈亏",
      value: `${account.unrealized_pnl >= 0 ? "+" : ""}${formatMoney(account.unrealized_pnl)}`,
      color: account.unrealized_pnl >= 0 ? "text-up" : "text-down",
    },
    {
      label: "今日盈亏",
      value: `${account.today_pnl >= 0 ? "+" : ""}${formatMoney(account.today_pnl)}`,
      color: account.today_pnl >= 0 ? "text-up" : "text-down",
    },
    {
      label: "风险率",
      value: `${Number(account.risk_rate || 0).toFixed(1)}%`,
      color:
        account.risk_rate > 80
          ? "text-[var(--accent-danger)]"
          : "text-[var(--accent-info)]",
    },
  ]

  return (
    <div className="flex items-center gap-6 px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] overflow-x-auto">
      {mode === "live" && account.account_id?.startsWith("live-") && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0">
          实盘
        </span>
      )}
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-[var(--text-muted)]">{item.label}</span>
          <span className={cn("font-num text-sm font-semibold", item.color)}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}
