"use client"

/**
 * AI 总收益横向柱状图
 * 一任务一柱：已实现 + 浮盈；盈红 / 亏绿
 */

import { useMemo, useState } from "react"
import type { ProfitCloseBar } from "@/lib/ai-trading-api"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import {
  barWidthPct,
  buildTaskProfitBars,
  colorForPnl,
  formatProfitAmount,
  type ProfitTaskBar,
} from "./profit-bar-data"

interface ProfitBarChartProps {
  items: ProfitCloseBar[]
  totalRealized: number
  totalUnrealized: number
  totalPnl: number
  openPositionCount: number
  loading: boolean
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  stopped: "已结束",
}

/** 总收益横向柱卡片 */
export function ProfitBarChart({
  items,
  totalRealized,
  totalUnrealized,
  totalPnl,
  openPositionCount,
  loading,
}: ProfitBarChartProps): React.JSX.Element {
  const bars = useMemo(() => buildTaskProfitBars(items), [items])
  const [hoverId, setHoverId] = useState<string | null>(null)

  const maxAbs = useMemo(() => {
    let m = 0
    for (const b of bars) m = Math.max(m, Math.abs(b.totalPnl))
    return m > 0 ? m : 1
  }, [bars])

  const hover = useMemo(
    () => bars.find((b) => b.taskId === hoverId) ?? null,
    [bars, hoverId],
  )
  const displayTotal = hover ? hover.totalPnl : totalPnl
  const winCount = bars.filter((b) => b.totalPnl > 0).length
  const lossCount = bars.filter((b) => b.totalPnl < 0).length

  return (
    <div className="relative rounded-2xl border border-[var(--border)] overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(100% 80% at 90% 0%, rgba(239,68,68,0.06), transparent 50%), radial-gradient(90% 70% at 10% 100%, rgba(34,197,94,0.05), transparent 55%), linear-gradient(180deg, rgba(15,17,21,0.35) 0%, var(--bg-secondary) 45%)",
        }}
      />

      <div className="relative p-3 md:p-4">
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold tracking-wide text-[var(--text-primary)]">
                总收益柱状图
              </h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
                一任务一柱 · 横向
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              每个任务一根横向柱：总收益 = 已实现 + 持仓浮盈
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[11px] px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)]/80">
              <span className="text-[var(--text-muted)]">总收益</span>{" "}
              {/* 定宽：悬停切换 总计↔单任务 数值时避免文本宽度变化引起顶行回流 */}
              <span
                className={`font-num font-semibold inline-block min-w-[4.6rem] text-right ${
                  displayTotal >= 0 ? "text-up" : "text-down"
                }`}
              >
                {formatProfitAmount(displayTotal)}
              </span>
            </div>
            <div className="text-[11px] px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]">
              已实现{" "}
              <span
                className={`font-num ${
                  totalRealized >= 0 ? "text-up" : "text-down"
                }`}
              >
                {formatProfitAmount(totalRealized)}
              </span>
              {" · "}
              浮盈{" "}
              <span
                className={`font-num ${
                  totalUnrealized >= 0 ? "text-up" : "text-down"
                }`}
              >
                {formatProfitAmount(totalUnrealized)}
              </span>
            </div>
            <div className="text-[11px] px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]">
              任务 {bars.length}（盈{winCount}/亏{lossCount}）
              {openPositionCount > 0 ? ` · 持仓 ${openPositionCount}` : ""}
            </div>
          </div>
        </div>

        <div className="relative rounded-xl border border-white/5 bg-black/20 p-3 min-h-[120px]">
          {bars.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-1">
              <span className="text-sm text-[var(--text-secondary)]">
                {loading ? "加载中…" : "暂无任务收益"}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                创建并运行任务后，每个任务显示一根横向柱
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              {bars.map((bar) => (
                <TaskBarRow
                  key={bar.taskId}
                  bar={bar}
                  maxAbs={maxAbs}
                  active={hoverId === bar.taskId}
                  onHover={setHoverId}
                />
              ))}
            </div>
          )}
        </div>

        {/* 悬停明细区常驻占位（固定高度）：条件渲染会造成卡片高度突变 →
            页面滚动条出现/消失 → 视口宽度回流 → 鼠标相对位置漂移 →
            悬停态反复进出（闪烁循环）。常驻后 hover 不再引起任何布局变化 */}
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]/80 px-3 py-2 text-xs min-h-[4.6rem] sm:min-h-[3.4rem] flex items-center">
          {hover ? (
            <div className="w-full grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <p className="text-[var(--text-muted)]">任务</p>
                <p className="text-[var(--text-primary)] truncate">{hover.name}</p>
              </div>
              <div>
                <p className="text-[var(--text-muted)]">合约</p>
                <p className="font-num text-[var(--text-primary)]">
                  {hover.symbolName || hover.symbol}
                  {hover.hasOpen ? " · 持仓中" : ""}
                </p>
              </div>
              <div>
                <p className="text-[var(--text-muted)]">已实现 / 浮盈</p>
                <p className="font-num text-[var(--text-primary)]">
                  <span className={hover.realized >= 0 ? "text-up" : "text-down"}>
                    {formatProfitAmount(hover.realized)}
                  </span>
                  {" / "}
                  <span
                    className={hover.unrealized >= 0 ? "text-up" : "text-down"}
                  >
                    {formatProfitAmount(hover.unrealized)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-[var(--text-muted)]">总收益</p>
                <p
                  className={`font-num font-semibold ${
                    hover.totalPnl >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {formatProfitAmount(hover.totalPnl)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[var(--text-muted)]">
              鼠标悬停柱条查看任务收益明细（已实现 / 浮盈 / 总收益）
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskBarRow(props: {
  bar: ProfitTaskBar
  maxAbs: number
  active: boolean
  onHover: (id: string | null) => void
}): React.JSX.Element {
  const { bar, maxAbs, active, onHover } = props
  const width = barWidthPct(bar.totalPnl, maxAbs)
  const color = colorForPnl(bar.totalPnl)
  const statusText = STATUS_LABEL[bar.status] || bar.status

  return (
    <div
      className={`grid grid-cols-[minmax(0,9rem)_1fr_auto] sm:grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${
        active ? "bg-white/5" : "hover:bg-white/[0.03]"
      }`}
      onMouseEnter={() => onHover(bar.taskId)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="min-w-0 flex items-center gap-1.5">
        <TaskIcon
          icon={bar.icon}
          modelId={bar.modelId}
          providerName={bar.providerName}
          displayName={bar.modelDisplayName || bar.name}
          strategyType={bar.strategyType}
          size={22}
        />
        <div className="min-w-0">
          <p className="text-xs text-[var(--text-primary)] truncate font-medium">
            {bar.name}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] truncate">
            {bar.symbolName || bar.symbol}
            {statusText ? ` · ${statusText}` : ""}
          </p>
        </div>
      </div>

      <div className="relative h-7 rounded-md bg-white/[0.04] overflow-hidden">
        <div
          className="absolute top-1 bottom-1 left-0 rounded-r-sm transition-all duration-300"
          style={{
            width: `${width}%`,
            background: color,
            boxShadow: active ? `0 0 14px ${color}` : undefined,
          }}
        />
      </div>

      <div
        className={`text-xs font-num font-semibold tabular-nums w-[5.75rem] text-right ${
          bar.totalPnl >= 0 ? "text-up" : "text-down"
        }`}
      >
        {formatProfitAmount(bar.totalPnl)}
      </div>
    </div>
  )
}
