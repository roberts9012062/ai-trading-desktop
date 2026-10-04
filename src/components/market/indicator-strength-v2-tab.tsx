"use client"

/**
 * 指标设置 —— 强弱 V2 参数页（形态档：衰竭/确认/中继，双向；算法见 lib/strength-v2.ts）
 * 由 IndicatorStrengthTab 的版本切换器在 v2 时渲染（范式同 IndicatorPivotV2Tab）。
 */

import { withNumericReset } from "@/lib/numeric-input"
import { useIndicatorStore } from "@/stores/indicator"
import { DEFAULT_INDICATOR_CONFIG, type IndicatorStoreHook } from "@/types/indicator"
import { ColorField, NumberField } from "./indicator-form-fields"

interface IndicatorStrengthV2TabProps {
  /** 可选：指定 store hook（回测/AI 看盘页传入专用 store 以隔离配置） */
  useStore?: IndicatorStoreHook
  /** 字段聚焦时通知示意图闪烁对应图形 */
  onHighlight?: (key: string | null) => void
}

/** 强弱 V2 配置面板（六档形态档参数） */
export function IndicatorStrengthV2Tab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorStrengthV2TabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const s = store.config.strengthV2
  const upd = store.updateStrengthV2
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={store.toggleStrengthV2}
          className="accent-[var(--primary)]"
        />
        启用强弱V2（0–100 副图蜡烛 + 六档形态信号，双向）
      </label>
      {s.enabled && (
        <div className="space-y-3">
          <NumberField label="归一化窗口" value={s.period} min={2} max={200}
            highlight="candles"
            onHighlight={onHighlight}
            onChange={(v) => upd({ period: v })} />
          <NumberField label="一次平滑" value={s.smooth} min={1} max={50}
            highlight="candles"
            onHighlight={onHighlight}
            onChange={(v) => upd({ smooth: v })} />
          <NumberField label="二次平滑" value={s.smooth2} min={1} max={50}
            highlight="candles"
            onHighlight={onHighlight}
            onChange={(v) => upd({ smooth2: v })} />
          <NumberField label="滞回带半宽" value={s.continuationBand} min={1} max={25}
            highlight="zone"
            onHighlight={onHighlight}
            onChange={(v) => upd({ continuationBand: v })} />
          <NumberField label="衰竭窗口" value={s.exhaustWindow} min={2} max={20}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ exhaustWindow: v })} />
          <NumberField label="收缩比上限" value={s.shrinkRatio} min={0.1} max={1} step={0.05}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ shrinkRatio: v })} />
          <NumberField label="走平实体上限" value={s.flatEps} min={0.1} max={20} step={0.1}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ flatEps: v })} />
          <NumberField label="段内位置容差" value={s.zoneDrop} min={1} max={50}
            highlight="zone"
            onHighlight={onHighlight}
            onChange={(v) => upd({ zoneDrop: v })} />
          <NumberField label="ATR 缓冲倍数" value={s.priceBufferAtrMult} min={0} max={5} step={0.1}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ priceBufferAtrMult: v })} />
          <NumberField label="ATR 周期" value={s.atrPeriod} min={2} max={200}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ atrPeriod: v })} />
          <NumberField label="冷却根数" value={s.cooldown} min={0} max={200}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ cooldown: v })} />
          <ColorField label="走强蜡烛色" value={s.upColor}
            highlight="candles"
            onHighlight={onHighlight}
            onChange={(c) => upd({ upColor: c })} />
          <ColorField label="走弱蜡烛色" value={s.downColor}
            highlight="candles"
            onHighlight={onHighlight}
            onChange={(c) => upd({ downColor: c })} />
          <ColorField label="中轴线颜色" value={s.midLineColor}
            highlight="midline"
            onHighlight={onHighlight}
            onChange={(c) => upd({ midLineColor: c })} />
          <ColorField label="做多箭头色" value={s.longSignalColor}
            highlight="arrowLong"
            onHighlight={onHighlight}
            onChange={(c) => upd({ longSignalColor: c })} />
          <ColorField label="做空箭头色" value={s.shortSignalColor}
            highlight="arrowShort"
            onHighlight={onHighlight}
            onChange={(c) => upd({ shortSignalColor: c })} />
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            默认 14/3/2：判定与显示同用二次平滑序列。三级递进 × 双向：
            底部/顶部（预警，动能衰竭转向）→ 反弹/破位（regime 翻转确认）→
            中继（回调不创新低再转向，ATR 缓冲确认）。滞回带内 regime 保持。
          </p>
        </div>
      )}
      {/* 只重置本指标块（参数与颜色回默认，enabled 保持当前值，不动其他指标） */}
      <button
        type="button"
        onClick={withNumericReset(() => upd({ ...DEFAULT_INDICATOR_CONFIG.strengthV2, enabled: s.enabled }))}
        className="mt-4 px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        恢复默认
      </button>
    </div>
  )
}
