"use client"

import { useMemo, useState } from "react"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { TaskProfitLockStatus } from "@/components/ai-trading/profit-lock-status"
import { TaskCloseControl } from "@/components/ai-trading/task-close-control"
import type {
  AITradingTask,
  EquityPoint,
  ProfitCloseBar,
} from "@/lib/ai-trading-api"
import { resolveSeriesColor } from "@/lib/provider-avatar"
import { cn } from "@/lib/utils"
import { taskLivePnl } from "./equity-data"
import { buildTaskProfitBars } from "../profit/profit-bar-data"
import type { Hunter } from "@/lib/hunter/api"
import { groupHunterRows } from "@/lib/hunter/profit-groups"
import { visibleHunterChildren } from "@/lib/hunter/task-visibility"

interface EquityLegendProps {
  tasks: AITradingTask[]
  series: Record<string, EquityPoint[]>
  values?: Map<string, number>
  allTasks?: AITradingTask[]
  hunters?: Hunter[]
  /** 总收益榜数据源（/profit-bars 或 showcase profit_items） */
  profitBars: ProfitCloseBar[]
  highlightTaskId: string | null
  onHighlightChange: (taskId: string | null) => void
}

type LegendMode = "floating" | "total"

function formatMoney(v: number): string {
  const abs = Math.abs(v)
  const sign = v >= 0 ? "+" : "-"
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2)}万`
  return `${sign}${abs.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** 统一的榜单行：浮盈榜与总收益榜共用一套卡片渲染 */
interface LegendRow {
  taskId: string
  displayName: string
  icon?: string | null
  strategyType?: string
  modelId?: string | null
  providerName?: string | null
  tagText: string
  tagClass: string
  symbolName: string
  symbol: string
  footnote: string
  value: number
  color: string
}

/**
 * 排行式图例：浮盈榜 / 总收益榜 Tab 切换；
 * hover 卡片联动上方收益曲线高亮。
 */
/** 数量自适应精度（0.30000000000000004 → 0.3；2000 → 2,000） */
function fmtQty(q: number): string {
  if (!Number.isFinite(q)) return "0"
  return q.toLocaleString("zh-CN", { maximumFractionDigits: 4 })
}

/** 价格自适应精度：≥1000→1 位；≥1→2 位；<1→4 位（微价格币不丢精度） */
function fmtPx(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "--"
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(4)
}

export function EquityLegend({
  tasks,
  series,
  values,
  allTasks = tasks,
  hunters = [],
  profitBars,
  highlightTaskId,
  onHighlightChange,
}: EquityLegendProps): React.JSX.Element {
  const [mode, setMode] = useState<LegendMode>("floating")

  // 持仓任务在折线图中的位置 → 让总收益榜里同任务颜色与折线一致
  const taskIndexInChart = useMemo(
    () => new Map(tasks.map((t, i) => [t.id, i])),
    [tasks],
  )

  // 浮盈榜：仅当前持仓任务，value=浮动盈亏
  const floatingRows = useMemo<LegendRow[]>(() => {
    return tasks
      .map((task, idx) => {
        const last = values?.get(task.id) ?? taskLivePnl(task, series[task.id] ?? [])
        const color = resolveSeriesColor(
          task.model_id,
          task.provider_name,
          task.model_display_name,
          idx,
        )
        let tagText = "空仓"
        let tagClass = "bg-white/5 text-[var(--text-muted)]"
        if (task.position_direction === "long") {
          tagText = `多 ${fmtQty(Number(task.position_qty ?? 0))} 币`
          tagClass = "bg-red-500/15 text-up"
        } else if (task.position_direction === "short") {
          tagText = `空 ${fmtQty(Number(task.position_qty ?? 0))} 币`
          tagClass = "bg-emerald-500/15 text-down"
        }
        return {
          taskId: task.id,
          displayName:
            task.model_display_name || task.provider_name || task.name,
          icon: task.icon,
          strategyType: task.strategy_type,
          modelId: task.model_id,
          providerName: task.provider_name,
          tagText,
          tagClass,
          symbolName: task.symbol_name || task.symbol,
          symbol: task.symbol,
          footnote: `${task.symbol_name || task.symbol} · ${task.timeframe}${
            task.position_avg_price != null
              ? ` · 开 ${fmtPx(Number(task.position_avg_price))}`
              : ""
          }`,
          value: last,
          color,
        }
      })
      .sort((a, b) => b.value - a.value)
  }, [tasks, series, values])

  // 总收益榜：全部任务，value=已实现+浮盈
  const totalRows = useMemo<LegendRow[]>(() => {
    const bars = buildTaskProfitBars(profitBars)
    return bars
      .map((bar, idx) => {
        const colorIdx = taskIndexInChart.has(bar.taskId)
          ? taskIndexInChart.get(bar.taskId)!
          : idx
        const color = resolveSeriesColor(
          bar.modelId,
          bar.providerName,
          bar.modelDisplayName || bar.name,
          colorIdx,
        )
        let tagText = "持仓中"
        let tagClass = "bg-sky-500/15 text-sky-300"
        if (!bar.hasOpen) {
          if (bar.status === "running") tagText = "运行中"
          else if (bar.status === "paused") tagText = "已暂停"
          else if (bar.status === "stopped") tagText = "已结束"
          else tagText = "已平仓"
          tagClass = "bg-white/5 text-[var(--text-muted)]"
        }
        const r = Number.isFinite(bar.realized) ? bar.realized : 0
        const u = Number.isFinite(bar.unrealized) ? bar.unrealized : 0
        return {
          taskId: bar.taskId,
          displayName:
            bar.modelDisplayName || bar.providerName || bar.name,
          icon: bar.icon,
          strategyType: bar.strategyType,
          modelId: bar.modelId,
          providerName: bar.providerName,
          tagText,
          tagClass,
          symbolName: bar.symbolName || bar.symbol,
          symbol: bar.symbol,
          footnote: `${bar.symbolName || bar.symbol} · 已实现 ${formatMoney(
            r,
          )} · 浮盈 ${formatMoney(u)}`,
          value: bar.totalPnl,
          color,
        }
      })
      .sort((a, b) => b.value - a.value)
  }, [profitBars, taskIndexInChart])

  const rows = mode === "floating" ? floatingRows : totalRows
  const grouped = useMemo(() => groupHunterRows(rows, allTasks, hunters).map(group => {
    if (!group.hunter) return { ...group, visibleChildren: group.children, row: group.children[0] }
    const visibleChildren = visibleHunterChildren(group.children, allTasks, group.hunter)
    const row = { ...group.children[0], taskId: group.id, displayName: group.hunter.name, modelId: null, providerName: null, icon: null, strategyType: "multi_cycle_hunter", tagText: `${visibleChildren.length} 个运行子任务`, tagClass: "bg-sky-500/15 text-sky-300", symbol: "", symbolName: "猎手收益汇总", footnote: "点击展开各币收益明细", value: group.children.reduce((sum, child) => sum + child.value, 0) }
    return { ...group, visibleChildren, row }
  }).filter(group => !group.hunter || group.hunter.status !== "stopped" || group.visibleChildren.length > 0).sort((a, b) => b.row.value - a.row.value), [rows, allTasks, hunters])
  const maxAbs = useMemo(() => {
    let m = 1
    for (const r of [...rows, ...grouped.map(group => group.row)]) m = Math.max(m, Math.abs(r.value))
    return m
  }, [rows, grouped])

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1 mb-2.5 flex-wrap">
        <TabButton active={mode === "floating"} onClick={() => setMode("floating")}>
          浮盈榜
          <CountBadge n={floatingRows.length} />
        </TabButton>
        <TabButton active={mode === "total"} onClick={() => setMode("total")}>
          总收益榜
          <CountBadge n={totalRows.length} />
        </TabButton>
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {mode === "floating"
            ? "当前持仓浮动盈亏（不含已实现）"
            : "已实现 + 持仓浮盈"}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] py-2">
          {mode === "floating"
            ? "暂无持仓任务；开仓后此处显示模型浮盈排行"
            : "暂无任务收益；创建并运行任务后此处显示总收益排行"}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {grouped.map((group, rank) => group.hunter ? <details key={group.id} className="min-w-0" data-testid="hunter-legend-group">
            <summary className="list-none cursor-pointer" aria-label={`${group.hunter.name}收益排行组，点击展开`}>
              <LegendCard row={group.row} rank={rank} maxAbs={maxAbs} highlightTaskId={highlightTaskId} onHighlightChange={onHighlightChange} summary />
            </summary>
            <div className="mt-2 space-y-2">
              {group.visibleChildren.map((row, index) => <LegendCard key={row.taskId} row={row} task={tasks.find(t => t.id === row.taskId)} rank={index} maxAbs={maxAbs} highlightTaskId={highlightTaskId} onHighlightChange={onHighlightChange} />)}
              {!group.visibleChildren.length && <p className="text-xs text-[var(--text-muted)]">暂无运行子任务 · 历史收益已计入汇总</p>}
            </div>
          </details> : (
            <LegendCard
              key={group.id}
              row={group.row}
              task={tasks.find(task => task.id === group.id)}
              rank={rank}
              maxAbs={maxAbs}
              highlightTaskId={highlightTaskId}
              onHighlightChange={onHighlightChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-200 border",
        active
          ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border-transparent",
      )}
    >
      {children}
    </button>
  )
}

function CountBadge({ n }: { n: number }): React.JSX.Element | null {
  if (!n) return null
  return (
    <span className="text-[9px] leading-none px-1 py-0.5 rounded-full bg-white/10 text-[var(--text-muted)] font-num">
      {n}
    </span>
  )
}

function LegendCard({
  row,
  task,
  rank,
  maxAbs,
  highlightTaskId,
  onHighlightChange,
  summary = false,
}: {
  row: LegendRow
  task?: AITradingTask
  rank: number
  maxAbs: number
  highlightTaskId: string | null
  onHighlightChange: (id: string | null) => void
  summary?: boolean
}): React.JSX.Element {
  const last = row.value
  const barPct = Math.min(100, (Math.abs(last) / maxAbs) * 100)
  const isLeader = rank === 0
  const isActive = highlightTaskId === row.taskId
  const isDimmed = highlightTaskId != null && highlightTaskId !== row.taskId

  return (
    <div
      role={summary ? undefined : "button"}
      tabIndex={summary ? undefined : 0}
      onMouseEnter={() => onHighlightChange(row.taskId)}
      onMouseLeave={() => onHighlightChange(null)}
      onFocus={() => onHighlightChange(row.taskId)}
      onBlur={() => onHighlightChange(null)}
      className={cn(
        "relative overflow-hidden rounded-xl border px-3 py-2.5 cursor-pointer",
        "bg-[var(--bg-tertiary)]/40 backdrop-blur-sm transition-all duration-200",
        "hover:bg-[var(--bg-tertiary)]/80",
        isActive && "ring-1",
        isDimmed && "opacity-45",
      )}
      style={{
        borderColor: isActive || isLeader ? `${row.color}aa` : `${row.color}33`,
        boxShadow: isActive || isLeader ? `0 0 20px ${row.color}28` : undefined,
        ["--tw-ring-color" as string]: row.color,
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0",
              isLeader
                ? "bg-amber-400/20 text-amber-300"
                : "bg-white/5 text-[var(--text-muted)]",
            )}
          >
            {rank + 1}
          </span>
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: row.color }}
          />
          <TaskIcon
            icon={row.icon}
            strategyType={row.strategyType}
            modelId={row.modelId}
            providerName={row.providerName}
            displayName={row.displayName}
            size={20}
          />
          <span className="text-xs text-[var(--text-primary)] font-medium truncate">
            {row.displayName}
          </span>
        </div>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded shrink-0",
            row.tagClass,
          )}
        >
          {row.tagText}
        </span>
      </div>

      <div
        className={cn(
          "font-num text-lg font-bold tabular-nums tracking-tight",
          last > 0 && "text-up",
          last < 0 && "text-down",
          last === 0 && "text-[var(--text-muted)]",
        )}
      >
        {formatMoney(last)}
      </div>

      <div className="mt-1.5 h-1 rounded-full bg-white/5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${barPct}%`,
            background:
              last >= 0
                ? `linear-gradient(90deg, ${row.color}55, ${row.color})`
                : `linear-gradient(90deg, ${row.color}, ${row.color}55)`,
            marginLeft: last < 0 ? `${100 - barPct}%` : 0,
          }}
        />
      </div>

      <div className="mt-1 text-[10px] text-[var(--text-muted)] truncate">
        {row.footnote}
      </div>
      {task && <TaskProfitLockStatus task={task} />}
      {task && !summary && <TaskCloseControl task={task} />}
    </div>
  )
}
