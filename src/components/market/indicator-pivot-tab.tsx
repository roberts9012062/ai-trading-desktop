"use client"

import { useIndicatorStore } from "@/stores/indicator"
import { DEFAULT_INDICATOR_CONFIG } from "@/types/indicator"
import { PIVOT_V2_ENABLED } from "@/lib/pivot-signals-v2"
import { ColorField, NumberField } from "./indicator-form-fields"
import { IndicatorPivotV2Tab } from "./indicator-pivot-v2-tab"

import type { IndicatorStoreHook } from "@/types/indicator"

interface IndicatorPivotTabProps {
  /** 可选：指定 store hook（回测页传入专用 store 以隔离配置） */
  useStore?: IndicatorStoreHook
  /** 字段聚焦时通知示意图闪烁对应图形 */
  onHighlight?: (key: string | null) => void
}

/** 波段信号（枢轴高低点）设置页 —— 顶部 V1/V2 二选一 */
export function IndicatorPivotTab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorPivotTabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  // V2 暂停期间展示层一律按 v1（存量 v2 存储配置不改，恢复后原样切回）
  const version =
    PIVOT_V2_ENABLED && (store.config.pivotVersion ?? "v1") === "v2"
      ? "v2"
      : "v1"
  const pivot = store.config.pivot ?? DEFAULT_INDICATOR_CONFIG.pivot

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          波段版本（二选一，同时只显示一组箭头）
        </div>
        <div className="flex gap-1 rounded-md border border-[var(--border)] p-1">
          {(
            [
              { key: "v1", label: "V1 经典" },
              { key: "v2", label: "V2 量价拒绝" },
            ] as const
          ).map((opt) => {
            const disabled = opt.key === "v2" && !PIVOT_V2_ENABLED
            return (
              <button
                key={opt.key}
                type="button"
                disabled={disabled}
                title={disabled ? "V2 经复盘判定信号不达标，暂停使用（2026-08-31）" : undefined}
                onClick={() => store.setPivotVersion(opt.key)}
                className={
                  "flex-1 rounded px-2 py-1 text-xs transition-colors " +
                  (disabled
                    ? "cursor-not-allowed text-[var(--text-muted)] opacity-50"
                    : version === opt.key
                      ? "bg-[var(--primary)] text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]")
                }
              >
                {opt.label}
                {disabled ? "（暂停使用）" : ""}
              </button>
            )
          })}
        </div>
        {!PIVOT_V2_ENABLED && (
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            V2 量价拒绝经实盘复盘判定信号不达标，已暂停使用（2026-08-31）；
            原选 V2 的用户暂时回落 V1，恢复后自动切回。
          </p>
        )}
      </div>

      {version === "v2" ? (
        <IndicatorPivotV2Tab useStore={useStore} onHighlight={onHighlight} />
      ) : (
        /* V1 参数区 —— 行为与改造前完全一致 */
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={pivot.enabled}
              onChange={store.togglePivot}
              className="accent-[var(--primary)]"
            />
            启用波段信号（波谷做多 / 波峰做空）
          </label>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            局部最低标红色向上箭头（做多），局部最高标绿色向下箭头（做空）。
            盘中预确认显示「多·/空·」，右侧确认K线全部收盘后显示「多/空」。近期交易箭头与量化均使用最近240根OKX永续K线。
          </p>
          {pivot.enabled && (
            <div className="space-y-3">
              <NumberField
                label="左侧确认根数"
                value={pivot.left}
                min={1}
                max={20}
                highlight="arrows"
                onHighlight={onHighlight}
                onChange={(v) => store.updatePivot({ left: v })}
              />
              <NumberField
                label="右侧确认根数（正式）"
                value={pivot.right}
                min={2}
                max={20}
                highlight="arrows"
                onHighlight={onHighlight}
                onChange={(v) => store.updatePivot({ right: v })}
              />
              <NumberField
                label="盘中预确认最少右侧根数"
                value={pivot.minRightLive ?? 1}
                min={1}
                max={pivot.right}
                highlight="arrows"
                onHighlight={onHighlight}
                onChange={(v) => store.updatePivot({ minRightLive: v })}
              />
              <p className="text-[10px] text-[var(--text-muted)] -mt-1">
                默认 1：价格刚从高/低点回撤 1 根即可出「多·/空·」；设为与右侧相同则只出正式信号。
              </p>
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={pivot.alternate}
                  onChange={(e) =>
                    store.updatePivot({ alternate: e.target.checked })
                  }
                  className="accent-[var(--primary)]"
                />
                多空交替（过滤连续同向）
              </label>

              <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
                <div className="text-xs font-medium text-[var(--text-secondary)]">
                  盘整过滤（ZigZag 幅度）
                </div>
                <NumberField
                  label="最小波段幅度 %"
                  value={pivot.minAmplitudePct ?? 1.5}
                  min={0}
                  max={20}
                  step={0.1}
                  highlight="arrows"
                onHighlight={onHighlight}
                onChange={(v) => store.updatePivot({ minAmplitudePct: v })}
                />
                <NumberField
                  label="最小波段 ATR 倍数"
                  value={pivot.minAtrMult ?? 1.5}
                  min={0}
                  max={10}
                  step={0.1}
                  highlight="arrows"
                onHighlight={onHighlight}
                onChange={(v) => store.updatePivot({ minAtrMult: v })}
                />
                <NumberField
                  label="ATR 周期"
                  value={pivot.atrPeriod ?? 14}
                  min={2}
                  max={100}
                  highlight="arrows"
                onHighlight={onHighlight}
                onChange={(v) => store.updatePivot({ atrPeriod: v })}
                />
                <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                  反向信号与上一枢轴的价差须 ≥ max(价格×%、ATR×倍数)。
                  两者都设 0 则不过滤盘整。幅度越大箭头越少、越偏大趋势。
                </p>
              </div>

              <ColorField
                label="做多箭头颜色"
                value={pivot.longColor}
                highlight="arrowLong"
                onHighlight={onHighlight}
                onChange={(c) => store.updatePivot({ longColor: c })}
              />
              <ColorField
                label="做空箭头颜色"
                value={pivot.shortColor}
                highlight="arrowShort"
                onHighlight={onHighlight}
                onChange={(c) => store.updatePivot({ shortColor: c })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
