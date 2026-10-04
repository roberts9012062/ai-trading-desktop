"use client"

/**
 * 指标设置 —— JDK（KDJ）页（onHighlight 联动右侧示意图闪烁）
 */

import { withNumericReset } from "@/lib/numeric-input"
import { useIndicatorStore } from "@/stores/indicator"
import { ColorField, NumberField } from "./indicator-form-fields"

import type { IndicatorStoreHook } from "@/types/indicator"

interface IndicatorJdkTabProps {
  /** 可选：指定 store hook（回测页传入专用 store 以隔离配置） */
  useStore?: IndicatorStoreHook
  /** 字段聚焦时通知示意图闪烁对应图形 */
  onHighlight?: (key: string | null) => void
}

/** JDK 配置面板 */
export function IndicatorJdkTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorJdkTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={store.config.jdk.enabled}
          onChange={store.toggleJDK}
          className="accent-[var(--primary)]"
        />
        启用 JDK（KDJ 随机指标）
      </label>
      {store.config.jdk.enabled && (
        <div className="space-y-3">
          <NumberField
            label="RSV 周期"
            value={store.config.jdk.rsvPeriod}
            min={2}
            max={200}
            highlight="k"
            onHighlight={onHighlight}
            onChange={(v) => store.updateJDK({ rsvPeriod: v })}
          />
          <NumberField
            label="K 平滑"
            value={store.config.jdk.kPeriod}
            min={2}
            max={50}
            highlight="k"
            onHighlight={onHighlight}
            onChange={(v) => store.updateJDK({ kPeriod: v })}
          />
          <NumberField
            label="D 平滑"
            value={store.config.jdk.dPeriod}
            min={2}
            max={50}
            highlight="d"
            onHighlight={onHighlight}
            onChange={(v) => store.updateJDK({ dPeriod: v })}
          />
          <ColorField
            label="K 线颜色"
            value={store.config.jdk.kColor}
            highlight="k"
            onHighlight={onHighlight}
            onChange={(c) => store.updateJDK({ kColor: c })}
          />
          <ColorField
            label="D 线颜色"
            value={store.config.jdk.dColor}
            highlight="d"
            onHighlight={onHighlight}
            onChange={(c) => store.updateJDK({ dColor: c })}
          />
          <ColorField
            label="J 线颜色"
            value={store.config.jdk.jColor}
            highlight="j"
            onHighlight={onHighlight}
            onChange={(c) => store.updateJDK({ jColor: c })}
          />
          <p className="text-[10px] text-[var(--text-muted)]">
            默认 9/3/3：RSV(n) → K 平滑 → D 平滑，J=3K-2D
          </p>
        </div>
      )}
      <button
        type="button"
        onClick={withNumericReset(store.resetToDefault)}
        className="mt-4 px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        恢复默认
      </button>
    </div>
  )
}
