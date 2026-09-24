"use client"

/**
 * AI 看盘行情 —— 右上任务信息面板
 *
 * 顶部保留行情页的卖一/买一价量与价差（数据源不变：WS orderbook + quote 兜底）；
 * 「盘口数据」区域替换为选中任务的具体内容：类型/模型、状态、品种·周期、
 * 持仓与实时浮盈、胜率统计、分配资金、运行时长。
 */

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { useMarketStore } from "@/stores/market"
import { useAppStore } from "@/stores/app"
import { useAiMarketStore } from "@/stores/ai-market"
import {
  livePnl,
  qtyLabel,
  runtimeLabel,
  statusKey,
  STATUS_LABEL,
  strategyLabel,
  winRateLabel,
} from "@/components/ai-trading/task-list-helpers"
import { TaskIcon } from "@/components/ai-trading/task-icon"

function lookup<T>(record: Record<string, T>, symbol: string): T | undefined {
  return record[symbol] ?? record[symbol.toLowerCase()] ?? record[symbol.toUpperCase()]
}

function fmtAmount(v: number | null | undefined): string {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return "--"
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)}万`
  return n.toFixed(2)
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-1 px-2 py-[3px]">
      <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
      <span className="text-right text-[12px] font-num text-[var(--text-primary)] truncate">
        {children}
      </span>
    </div>
  )
}

export function TaskInfoPanel(): React.JSX.Element {
  const tasks = useAiMarketStore((s) => s.tasks)
  const selectedTaskId = useAiMarketStore((s) => s.selectedTaskId)
  const activeContract = useAppStore((s) => s.activeContract)
  const orderbooks = useMarketStore((s) => s.orderbooks)
  const quotes = useMarketStore((s) => s.quotes)

  const task = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  )
  const quote = lookup(quotes, activeContract)
  const book = lookup(orderbooks, activeContract)
  const ask = book?.asks?.[0] ??
    (quote?.ask_price
      ? { price: quote.ask_price, volume: quote.ask_vol ?? 0 }
      : undefined)
  const bid = book?.bids?.[0] ??
    (quote?.bid_price
      ? { price: quote.bid_price, volume: quote.bid_vol ?? 0 }
      : undefined)
  const decimals = quote?.decimal_places ?? 0
  const spread = ask && bid ? ask.price - bid.price : null

  const pnl = task ? livePnl(task, quote?.last_price) : null
  const isQuant = task ? String(task.strategy_type ?? "ai").toLowerCase() !== "ai" : false
  const sk = task ? statusKey(task) : ""

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
      {/* 买卖价格（与行情页盘口一致） */}
      <div className="shrink-0 border-b border-[var(--border)] py-1">
        <div className="grid grid-cols-[44px_1fr_64px] items-center px-2 py-1">
          <span className="text-[13px] text-[var(--text-primary)]">卖价</span>
          <span className="font-num text-[17px] font-semibold text-down">
            {ask ? ask.price.toFixed(decimals) : "--"}
          </span>
          <span className="text-right font-num text-[15px] text-[var(--accent-info)]">
            {ask ? ask.volume : "--"}
          </span>
        </div>
        <div className="grid grid-cols-[44px_1fr_64px] items-center px-2 py-1">
          <span className="text-[13px] text-[var(--text-primary)]">买价</span>
          <span className="font-num text-[17px] font-semibold text-up">
            {bid ? bid.price.toFixed(decimals) : "--"}
          </span>
          <span className="text-right font-num text-[15px] text-[var(--accent-info)]">
            {bid ? bid.volume : "--"}
          </span>
        </div>
        <div className="flex items-center justify-between px-2 pt-1 text-[10px] text-[var(--text-muted)]">
          <span>
            价差 {spread === null ? "--" : spread.toFixed(decimals)} · 最新{" "}
            {quote?.last_price?.toFixed(decimals) ?? "--"}
          </span>
          <span>
            {quote?.change_pct != null && quote.change_pct !== 0
              ? `${quote.change_pct > 0 ? "+" : ""}${quote.change_pct.toFixed(2)}%`
              : ""}
          </span>
        </div>
      </div>

      {/* 任务具体内容 */}
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-2 py-1">
        <span className="text-[12px] text-[var(--text-primary)]">任务详情</span>
        {task && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[9px]",
              isQuant
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-[var(--primary)]/15 text-[var(--primary)]",
            )}
          >
            {isQuant ? "量化任务" : "AI任务"}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!task ? (
          <p className="text-xs text-[var(--text-muted)] text-center py-8">
            左侧选择一个任务
          </p>
        ) : (
          <>
            {/* 任务头 */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <TaskIcon
                icon={task.icon}
                modelId={task.model_id}
                providerName={task.provider_name}
                displayName={task.model_display_name}
                strategyType={task.strategy_type}
                size={24}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                  {task.name}
                </p>
                <p className="text-[10px] text-[var(--text-muted)] truncate">
                  {strategyLabel(task)}
                </p>
              </div>
            </div>

            <div className="border-t border-[var(--border)]/60 pt-1">
              <Row label="状态">
                <span
                  className={cn(
                    sk === "running" && "text-emerald-400",
                    sk === "paused" && "text-amber-400",
                    sk === "market_closed" && "text-sky-400",
                    sk === "stopped" && "text-zinc-400",
                  )}
                >
                  {STATUS_LABEL[sk] ?? task.status}
                </span>
              </Row>
              <Row label="品种·周期">
                {task.symbol} · {task.timeframe}
              </Row>
              <Row label="仓位规则">{qtyLabel(task)}</Row>

              {/* 持仓 */}
              <div className="mt-1 border-t border-[var(--border)]/60 pt-1">
                {pnl?.hasPosition ? (
                  <>
                    <Row label="持仓">
                      <span
                        className={cn(
                          "font-semibold",
                          pnl.direction === "long" ? "text-up" : "text-down",
                        )}
                      >
                        {pnl.direction === "long" ? "多" : "空"} {pnl.qty} 币
                      </span>
                    </Row>
                    <Row label="开仓均价">{pnl.avg?.toFixed(decimals) ?? "--"}</Row>
                    <Row label="最新价">{pnl.last?.toFixed(decimals) ?? "--"}</Row>
                    <Row label="浮动盈亏">
                      <span
                        className={cn(
                          "font-semibold",
                          pnl.pnl > 0 ? "text-up" : pnl.pnl < 0 ? "text-down" : "",
                        )}
                      >
                        {pnl.pnl > 0 ? "+" : ""}
                        {pnl.pnl.toFixed(2)}
                      </span>
                    </Row>
                  </>
                ) : (
                  <Row label="持仓">
                    <span className="text-[var(--text-muted)]">空仓</span>
                  </Row>
                )}
              </div>

              {/* 统计 */}
              <div className="mt-1 border-t border-[var(--border)]/60 pt-1">
                <Row label="已实现">
                  <span className="text-[var(--text-secondary)]">
                    {task.cash_delta != null
                      ? `${Number(task.cash_delta) > 0 ? "+" : ""}${fmtAmount(task.cash_delta)}`
                      : "--"}
                  </span>
                </Row>
                <Row label="胜率统计">
                  <span className="text-[var(--text-secondary)]">
                    {winRateLabel(task)}
                  </span>
                </Row>
                <Row label="分配资金">
                  <span className="text-[var(--text-secondary)]">
                    {task.allocated_capital != null
                      ? fmtAmount(task.allocated_capital)
                      : "--"}
                  </span>
                </Row>
                <Row label="运行时长">
                  <span className="text-[var(--text-secondary)]">
                    {runtimeLabel(task) || "--"}
                  </span>
                </Row>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
