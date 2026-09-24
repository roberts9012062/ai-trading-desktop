"use client"

/**
 * 指标设置 —— 均线页（自弹窗内联拆出；onHighlight 联动右侧示意图闪烁）
 */

import { useIndicatorStore } from "@/stores/indicator"
import type { IndicatorStoreHook } from "@/types/indicator"
import { PRESET_COLORS } from "@/types/indicator"
import { ColorField } from "./indicator-form-fields"

interface IndicatorMaTabProps {
  useStore?: IndicatorStoreHook
  onHighlight?: (key: string | null) => void
}

export function IndicatorMaTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorMaTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  return (
    <div className="space-y-2">
      {store.config.maLines.map((line, i) => (
        <div
          key={i}
          className="space-y-2 py-2 border-b border-[var(--border)] last:border-0"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={line.period}
              min={2}
              max={500}
              onFocus={() => onHighlight?.("ma")}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v >= 2 && v <= 500) store.updateMALine(i, { period: v })
              }}
              className="w-20 px-2 py-1 text-xs bg-[var(--bg-tertiary)] rounded border border-[var(--border)] text-[var(--text-primary)]"
            />
            <span className="text-xs text-[var(--text-muted)]">周期</span>
            <button
              type="button"
              onClick={() => store.removeMALine(i)}
              className="ml-auto text-xs text-red-400 hover:text-red-300 cursor-pointer"
            >
              删除
            </button>
          </div>
          <ColorField
            label={`MA${line.period} 颜色`}
            value={line.color}
            highlight="ma"
            onHighlight={onHighlight}
            onChange={(color) => store.updateMALine(i, { color })}
          />
        </div>
      ))}
      {store.config.maLines.length < 5 ? (
        <button
          type="button"
          onClick={store.addMALine}
          className="mt-1 px-3 py-1 text-xs rounded bg-[var(--primary)] text-white hover:opacity-90 cursor-pointer"
        >
          + 添加均线
        </button>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">最多 5 条均线</p>
      )}
      <p className="text-[10px] text-[var(--text-muted)]">
        预设色：{PRESET_COLORS.length} 色（在颜色控件中点选）
      </p>
    </div>
  )
}
