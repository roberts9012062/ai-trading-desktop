"use client"

/**
 * 指标设置 —— MACD 页（自弹窗内联拆出；onHighlight 联动右侧示意图闪烁）
 */

import { useIndicatorStore } from "@/stores/indicator"
import type { IndicatorStoreHook } from "@/types/indicator"
import { ColorField, NumberField } from "./indicator-form-fields"

interface IndicatorMacdTabProps {
  useStore?: IndicatorStoreHook
  onHighlight?: (key: string | null) => void
}

export function IndicatorMacdTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorMacdTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const macd = store.config.macd
  const upd = store.updateMACD
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={macd.enabled}
          onChange={store.toggleMACD}
          className="accent-[var(--primary)]"
        />
        启用 MACD
      </label>
      {macd.enabled && (
        <div className="space-y-3">
          <NumberField label="快线周期" value={macd.fastPeriod} min={2} max={200} highlight="dif"
            onHighlight={onHighlight} onChange={(v) => upd({ fastPeriod: v })} />
          <NumberField label="慢线周期" value={macd.slowPeriod} min={2} max={200} highlight="dif"
            onHighlight={onHighlight} onChange={(v) => upd({ slowPeriod: v })} />
          <NumberField label="信号线周期" value={macd.signalPeriod} min={2} max={200} highlight="dea"
            onHighlight={onHighlight} onChange={(v) => upd({ signalPeriod: v })} />
          <ColorField label="DIF 颜色" value={macd.difColor} highlight="dif"
            onHighlight={onHighlight} onChange={(c) => upd({ difColor: c })} />
          <ColorField label="DEA 颜色" value={macd.deaColor} highlight="dea"
            onHighlight={onHighlight} onChange={(c) => upd({ deaColor: c })} />
          <ColorField label="柱上涨色" value={macd.histUpColor} highlight="histUp"
            onHighlight={onHighlight} onChange={(c) => upd({ histUpColor: c })} />
          <ColorField label="柱下跌色" value={macd.histDownColor} highlight="histDown"
            onHighlight={onHighlight} onChange={(c) => upd({ histDownColor: c })} />
        </div>
      )}
    </div>
  )
}
