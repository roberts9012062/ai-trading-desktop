"use client"

import {
  PRESET_COLORS,
  type IndicatorLineStyle,
} from "@/types/indicator"
import { cn } from "@/lib/utils"

/** 数字输入行（highlight/onHighlight：聚焦时通知示意图闪烁对应图形） */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  highlight,
  onHighlight,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  highlight?: string
  onHighlight?: (key: string | null) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center justify-between text-sm text-[var(--text-primary)]">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onFocus={() => onHighlight?.(highlight ?? null)}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (v >= min && v <= max) onChange(v)
        }}
        className="w-20 px-2 py-1 text-xs bg-[var(--bg-tertiary)] rounded border border-[var(--border)] text-[var(--text-primary)]"
      />
    </label>
  )
}

/** 颜色选择：预设色块 + 自定义 color input */
export function ColorField({
  label,
  value,
  onChange,
  highlight,
  onHighlight,
}: {
  label: string
  value: string
  onChange: (color: string) => void
  highlight?: string
  onHighlight?: (key: string | null) => void
}): React.JSX.Element {
  const pickerValue =
    value.startsWith("#") && value.length >= 7 ? value.slice(0, 7) : "#3b82f6"

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm text-[var(--text-primary)]">
        <span>{label}</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={pickerValue}
            onFocus={() => onHighlight?.(highlight ?? null)}
            onChange={(e) => onChange(e.target.value)}
            className="w-7 h-7 p-0 border-0 bg-transparent cursor-pointer rounded"
            title="自定义颜色"
          />
          <span className="text-[10px] text-[var(--text-muted)] font-mono max-w-[88px] truncate">
            {value}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onFocus={() => onHighlight?.(highlight ?? null)}
            onClick={() => onChange(c)}
            className={cn(
              "w-5 h-5 rounded-full cursor-pointer transition-transform",
              value === c || value.startsWith(c)
                ? "ring-2 ring-white scale-110"
                : "opacity-60 hover:opacity-100",
            )}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
      </div>
    </div>
  )
}

/** 线型切换：实线 / 虚线 */
export function LineStyleField({
  label,
  value,
  onChange,
  highlight,
  onHighlight,
}: {
  label: string
  value: IndicatorLineStyle
  onChange: (style: IndicatorLineStyle) => void
  highlight?: string
  onHighlight?: (key: string | null) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm text-[var(--text-primary)]">
      <span>{label}</span>
      <div className="flex gap-1">
        {(
          [
            { key: "solid" as const, text: "实线" },
            { key: "dashed" as const, text: "虚线" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.key}
            type="button"
            onFocus={() => onHighlight?.(highlight ?? null)}
            onClick={() => onChange(opt.key)}
            className={cn(
              "px-2 py-1 text-[11px] rounded border cursor-pointer transition-colors",
              value === opt.key
                ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
            )}
          >
            {opt.text}
          </button>
        ))}
      </div>
    </div>
  )
}
