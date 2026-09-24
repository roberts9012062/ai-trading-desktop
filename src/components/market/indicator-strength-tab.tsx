"use client"

/**
 * 指标设置 —— 强弱页（顶部 V1/V2 版本切换器，范式同 IndicatorPivotTab）
 * V1 参数区行为与改造前完全一致；v2 时渲染 IndicatorStrengthV2Tab。
 */

import { useIndicatorStore } from "@/stores/indicator"
import { DEFAULT_INDICATOR_CONFIG, type IndicatorStoreHook } from "@/types/indicator"
import { ColorField, NumberField } from "./indicator-form-fields"
import { IndicatorStrengthV2Tab } from "./indicator-strength-v2-tab"

interface IndicatorStrengthTabProps {
  /** 可选：指定 store hook（回测/AI 看盘页传入专用 store 以隔离配置） */
  useStore?: IndicatorStoreHook
  /** 字段聚焦时通知示意图闪烁对应图形 */
  onHighlight?: (key: string | null) => void
}

/** 强弱指标配置面板（V1/V2 二选一） */
export function IndicatorStrengthTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorStrengthTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const version = store.config.strengthVersion ?? "v1"

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          强弱版本（二选一，同时只显示一组信号）
        </div>
        <div className="flex gap-1 rounded-md border border-[var(--border)] p-1">
          {(
            [
              { key: "v1", label: "V1 三档" },
              { key: "v2", label: "V2 形态档" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => store.setStrengthVersion(opt.key)}
              className={
                "flex-1 rounded px-2 py-1 text-xs transition-colors " +
                (version === opt.key
                  ? "bg-[var(--primary)] text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]")
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {version === "v2" ? (
        <IndicatorStrengthV2Tab useStore={useStore} onHighlight={onHighlight} />
      ) : (
        <StrengthV1Panel useStore={useStore} onHighlight={onHighlight} />
      )}
    </div>
  )
}

/** V1 参数区 —— 行为与改造前完全一致 */
function StrengthV1Panel({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorStrengthTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const s = store.config.strength
  const upd = store.updateStrength
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={store.toggleStrength}
          className="accent-[var(--primary)]"
        />
        启用强弱（0–100 副图蜡烛 + 三档进场）
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
          <NumberField label="趋势均线周期" value={s.trendMaPeriod} min={2} max={200}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ trendMaPeriod: v })} />
          <NumberField label="波段阈值" value={s.swingThreshold} min={0} max={100}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ swingThreshold: v })} />
          <NumberField label="反弹阈值" value={s.reboundThreshold} min={0} max={100}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ reboundThreshold: v })} />
          <NumberField label="弱区线" value={s.oversoldLevel} min={0} max={50}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ oversoldLevel: v })} />
          <NumberField label="反弹回溯" value={s.reboundLookback} min={1} max={100}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ reboundLookback: v })} />
          <NumberField label="极低位线" value={s.deepLevel} min={0} max={30}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ deepLevel: v })} />
          <NumberField label="钝化根数" value={s.deepBars} min={1} max={50}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => upd({ deepBars: v })} />
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
          <ColorField label="信号箭头色" value={s.signalColor}
            highlight="arrows"
            onHighlight={onHighlight}
            onChange={(c) => upd({ signalColor: c })} />
          <p className="text-[10px] text-[var(--text-muted)]">
            默认 14/3/1/10、阈值 50：红=走强、青=走弱；波段=顺势中继，
            反弹=弱区回升，超跌=极低位首次拐头（优先级 超跌&gt;反弹&gt;波段）
          </p>
        </div>
      )}
      {/* 只重置本指标块（参数与颜色回默认，enabled 保持当前值，不动其他指标） */}
      <button
        type="button"
        onClick={() => upd({ ...DEFAULT_INDICATOR_CONFIG.strength, enabled: s.enabled })}
        className="mt-4 px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        恢复默认
      </button>
    </div>
  )
}
