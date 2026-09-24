"use client"

import { memo } from "react"
import type { KlineBar } from "@/types"
import { cn } from "@/lib/utils"

/** 面板定位模式：右半区鼠标 → 面板在左上；左半区鼠标 → 面板在右上 */
export type HoverPanelPosition = "left" | "right"

/** 面板可见状态（visible=false 时淡出隐藏）
 *
 * 存 barIndex 而不是 bar 快照,这样最新 bar 上的实时 tick 能自动反映到面板:
 * 父组件每次渲染时基于 currentBars[barIndex] + realtime bar 派生显示数据。
 */
export interface HoverPanelState {
  barIndex: number | null
  position: HoverPanelPosition
  visible: boolean
}

/** 项目配色 —— 红涨绿跌 */
const COLOR_UP = "#ef4444"
const COLOR_DOWN = "#22c55e"
const COLOR_FLAT = "#9ca3af"

/** 字段缺失时的占位符 */
const PLACEHOLDER = "--"

interface KlineHoverInfoPanelProps {
  /** 当前对齐到的 bar；为 null 时面板隐藏 */
  bar: KlineBar | null
  /** 面板锚定方向：'left' → 浮在左上角；'right' → 浮在右上角 */
  position: HoverPanelPosition
  /** 是否可见（鼠标进入图表区域后为 true） */
  visible: boolean
  /** K 线周期：日线与分钟线使用不同的时间格式 */
  period: "1m" | "5m" | "15m" | "30m" | "60m" | "1d" | "tick"
  /** 价格小数位（按品种 tick 推导：rb=0, au=2）；默认 0 */
  decimalPlaces?: number
  /** 该 bar 上的任务成交明细（AI 看盘页传入；空则不显示该区块） */
  trades?: { label: string; value: string; color: string }[]
}

/** 时间格式化：日线 YYYY-MM-DD；分钟线 YYYY-MM-DD HH:MM */
function formatTime(time: string, period: KlineHoverInfoPanelProps["period"]): string {
  if (!time) return PLACEHOLDER
  // 日线："2026-07-01" → 直接返回日期部分
  // 分钟线："2026-07-01 10:30:00" → 截取到分钟
  const daily = period === "1d"
  if (daily) {
    return time.slice(0, 10)
  }
  const head = time.slice(0, 10)
  const timePart = time.slice(11, 16)
  return timePart ? `${head} ${timePart}` : head
}

/** 价格格式化：按品种小数位精度，去除尾零 */
function formatPrice(value: number | null | undefined, decimalPlaces = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return PLACEHOLDER
  return Number(value.toFixed(decimalPlaces)).toString()
}

/** 成交量/持仓量：千分位分隔 */
function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return PLACEHOLDER
  return Math.round(value).toLocaleString("en-US")
}

/** 价格百分比：(close - open) / open × 100，保留 2 位小数 */
function formatPercent(open: number, close: number): { text: string; color: string } {
  if (open === 0 || Number.isNaN(open) || Number.isNaN(close)) {
    return { text: PLACEHOLDER, color: COLOR_FLAT }
  }
  const pct = (close - open) / open * 100
  const rounded = Math.round(pct * 100) / 100
  const sign = rounded > 0 ? "+" : ""
  return {
    text: `${sign}${rounded.toFixed(2)}%`,
    color: rounded > 0 ? COLOR_UP : rounded < 0 ? COLOR_DOWN : COLOR_FLAT,
  }
}

/** 单行字段：label 左对齐 + value 右对齐 */
function FieldRow({
  label,
  value,
  valueClassName,
  valueStyle,
}: {
  label: string
  value: string
  valueClassName?: string
  valueStyle?: React.CSSProperties
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 leading-tight">
      <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      <span
        className={cn("text-[11px] font-mono tabular-nums text-right", valueClassName)}
        style={valueStyle}
      >
        {value}
      </span>
    </div>
  )
}

/** K 线悬停浮空信息面板
 *
 *  - 11 字段：实时价格 / 时间 / 开 / 高 / 低 / 收 / 差价 / 涨跌幅 / 结算价 / 成交量 / 持仓量
 *  - 智能左右定位：position === 'right' → top:12px right:12px；'left' → top:12px left:12px
 *  - 淡入淡出动画 ≤ 150ms（opacity + transform）
 *  - 字段缺失（settle / open_interest 为 null）→ 显示 `--`
 */
export const KlineHoverInfoPanel = memo(function KlineHoverInfoPanel({
  bar,
  position,
  visible,
  period,
  decimalPlaces = 0,
  trades,
}: KlineHoverInfoPanelProps): React.JSX.Element | null {
  // 无 bar 时一律隐藏（避免显示空白面板）
  if (!bar) return null

  const dp = decimalPlaces
  const diff = bar.high - bar.low
  const pct = formatPercent(bar.open, bar.close)
  const lastPriceColor =
    bar.close > bar.open ? COLOR_UP : bar.close < bar.open ? COLOR_DOWN : COLOR_FLAT

  // 实时价格/收盘价取 close 字段（与项目 candle 配色一致）
  const settleDisplay = formatPrice(bar.settle ?? null, dp)
  const oiRaw = bar.open_interest ?? bar.openInterest ?? null
  const oiDisplay = formatInteger(oiRaw)

  const anchorClass =
    position === "right" ? "top-3 right-3" : "top-3 left-3"

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-20 w-[200px] rounded-md border border-[var(--border)] bg-[#1a1a1e]/95 px-2.5 py-2 shadow-lg backdrop-blur-sm",
        "transition-opacity duration-150 ease-out",
        anchorClass,
        visible ? "opacity-100" : "opacity-0",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col gap-[3px]">
        <FieldRow
          label="实时"
          value={formatPrice(bar.close, dp)}
          valueStyle={{ color: lastPriceColor, fontWeight: 600 }}
        />
        <FieldRow label="时间" value={formatTime(bar.time, period)} />
        <FieldRow label="开" value={formatPrice(bar.open, dp)} />
        <FieldRow label="高" value={formatPrice(bar.high, dp)} valueStyle={{ color: COLOR_UP }} />
        <FieldRow label="低" value={formatPrice(bar.low, dp)} valueStyle={{ color: COLOR_DOWN }} />
        <FieldRow label="收" value={formatPrice(bar.close, dp)} valueStyle={{ color: lastPriceColor }} />
        <FieldRow label="差价" value={formatPrice(diff, dp)} />
        <FieldRow label="涨跌" value={pct.text} valueStyle={{ color: pct.color, fontWeight: 600 }} />
        <FieldRow label="结算" value={settleDisplay} />
        <FieldRow label="量" value={formatInteger(bar.volume)} />
        <FieldRow label="仓" value={oiDisplay} />
        {trades && trades.length > 0 && (
          <div className="mt-1 pt-1 border-t border-[var(--border)] flex flex-col gap-[3px]">
            <span className="text-[10px] text-[var(--text-muted)]">任务成交</span>
            {trades.map((t) => (
              <FieldRow
                key={t.label}
                label={t.label}
                value={t.value}
                valueStyle={{ color: t.color, fontWeight: 600 }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
