"use client"

/**
 * 指标设置 —— 布林带页（自弹窗内联拆出；onHighlight 联动右侧示意图闪烁）
 */

import { useIndicatorStore } from "@/stores/indicator"
import type { IndicatorStoreHook } from "@/types/indicator"
import { ColorField, LineStyleField, NumberField } from "./indicator-form-fields"

interface IndicatorBollTabProps {
  useStore?: IndicatorStoreHook
  onHighlight?: (key: string | null) => void
}

export function IndicatorBollTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorBollTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const boll = store.config.boll
  const upd = store.updateBOLL
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={boll.enabled}
          onChange={store.toggleBOLL}
          className="accent-[var(--primary)]"
        />
        启用布林带（主图轨道）
      </label>
      {boll.enabled && (
        <div className="space-y-3">
          <NumberField label="中轨周期" value={boll.period} min={2} max={200} highlight="bollMiddle"
            onHighlight={onHighlight} onChange={(v) => upd({ period: v })} />
          <NumberField label="标准差倍数" value={boll.std} min={0.5} max={5} step={0.1} highlight="bollMiddle"
            onHighlight={onHighlight} onChange={(v) => upd({ std: v })} />
          <ColorField label="上轨颜色" value={boll.upperColor} highlight="bollUpper"
            onHighlight={onHighlight} onChange={(c) => upd({ upperColor: c })} />
          <LineStyleField label="上轨线型" value={boll.upperStyle} highlight="bollUpper"
            onHighlight={onHighlight} onChange={(s) => upd({ upperStyle: s })} />
          <ColorField label="中轨颜色" value={boll.middleColor} highlight="bollMiddle"
            onHighlight={onHighlight} onChange={(c) => upd({ middleColor: c })} />
          <LineStyleField label="中轨线型" value={boll.middleStyle} highlight="bollMiddle"
            onHighlight={onHighlight} onChange={(s) => upd({ middleStyle: s })} />
          <ColorField label="下轨颜色" value={boll.lowerColor} highlight="bollLower"
            onHighlight={onHighlight} onChange={(c) => upd({ lowerColor: c })} />
          <LineStyleField label="下轨线型" value={boll.lowerStyle} highlight="bollLower"
            onHighlight={onHighlight} onChange={(s) => upd({ lowerStyle: s })} />
        </div>
      )}
    </div>
  )
}
