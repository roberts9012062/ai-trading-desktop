"use client"

/**
 * 指标设置 —— RSI 页（自弹窗内联拆出；onHighlight 联动右侧示意图闪烁）
 */

import { useIndicatorStore } from "@/stores/indicator"
import type { IndicatorStoreHook } from "@/types/indicator"
import { ColorField, NumberField } from "./indicator-form-fields"

interface IndicatorRsiTabProps {
  useStore?: IndicatorStoreHook
  onHighlight?: (key: string | null) => void
}

export function IndicatorRsiTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorRsiTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const rsi = store.config.rsi
  const upd = store.updateRSI
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={rsi.enabled}
          onChange={store.toggleRSI}
          className="accent-[var(--primary)]"
        />
        启用 RSI（超买超卖）
      </label>
      {rsi.enabled && (
        <div className="space-y-3">
          <NumberField label="RSI 周期" value={rsi.period} min={2} max={200} highlight="rsi"
            onHighlight={onHighlight} onChange={(v) => upd({ period: v })} />
          <NumberField label="超买线" value={rsi.overbought} min={50} max={100} highlight="overbought"
            onHighlight={onHighlight} onChange={(v) => upd({ overbought: v })} />
          <NumberField label="超卖线" value={rsi.oversold} min={0} max={50} highlight="oversold"
            onHighlight={onHighlight} onChange={(v) => upd({ oversold: v })} />
          <ColorField label="RSI 线颜色" value={rsi.lineColor} highlight="rsi"
            onHighlight={onHighlight} onChange={(c) => upd({ lineColor: c })} />
          <ColorField label="超买线颜色" value={rsi.overboughtColor} highlight="overbought"
            onHighlight={onHighlight} onChange={(c) => upd({ overboughtColor: c })} />
          <ColorField label="超卖线颜色" value={rsi.oversoldColor} highlight="oversold"
            onHighlight={onHighlight} onChange={(c) => upd({ oversoldColor: c })} />
        </div>
      )}
      <button
        type="button"
        onClick={store.resetToDefault}
        className="mt-4 px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        恢复默认
      </button>
    </div>
  )
}
