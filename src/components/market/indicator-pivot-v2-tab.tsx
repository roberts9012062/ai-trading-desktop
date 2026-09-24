"use client"

import { useIndicatorStore } from "@/stores/indicator"
import { DEFAULT_INDICATOR_CONFIG } from "@/types/indicator"
import { ColorField, NumberField } from "./indicator-form-fields"

import type { IndicatorStoreHook } from "@/types/indicator"

interface IndicatorPivotV2TabProps {
  /** 可选：指定 store hook（回测页/分屏传入专用 store 以隔离配置） */
  useStore?: IndicatorStoreHook
  /** 字段聚焦时通知示意图闪烁对应图形 */
  onHighlight?: (key: string | null) => void
}

/**
 * 波段信号 V2 设置页（前期高低点 + 量价拒绝形态 + 突破即假信号）
 *
 * 语义：前期高点处放量上影拒绝 / 缩量多K上攻失败 → 做空；前期低点镜像 →
 * 做多；参考极值被突破 = 假信号灰显 ✕。算法见 lib/pivot-signals-v2.ts。
 */
export function IndicatorPivotV2Tab({
  useStore = useIndicatorStore as IndicatorStoreHook,
  onHighlight,
}: IndicatorPivotV2TabProps = {}): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const pivot = store.config.pivotV2 ?? DEFAULT_INDICATOR_CONFIG.pivotV2

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={pivot.enabled}
          onChange={store.togglePivotV2}
          className="accent-[var(--primary)]"
        />
        启用波段信号 V2（量价拒绝形态）
      </label>
      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        相对 V1 的差异：不再等右侧确认，在<span className="text-[var(--text-secondary)]">前期高点/低点</span>处出现
        <span className="text-[var(--text-secondary)]">放量影线拒绝</span>或
        <span className="text-[var(--text-secondary)]">缩量多K上攻失败</span>即刻出信号；
        参考位被突破的箭头灰显带 ✕（假空/假多）。箭头文案：空放/多放=放量拒绝、
        空缩/多缩=缩量失败。
      </p>

      {pivot.enabled && (
        <div className="space-y-3">
          <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
            <div className="text-xs font-medium text-[var(--text-secondary)]">
              前期高低点（参考位）
            </div>
            <NumberField
              label="左侧确认根数"
              value={pivot.left}
              min={2}
              max={20}
              highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => store.updatePivotV2({ left: v })}
            />
            <NumberField
              label="右侧确认根数"
              value={pivot.right}
              min={2}
              max={20}
              highlight="arrows"
            onHighlight={onHighlight}
            onChange={(v) => store.updatePivotV2({ right: v })}
            />
            <NumberField
              label="冲击到位容差（×ATR）"
              value={pivot.proximityAtrMult ?? 1.0}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) => store.updatePivotV2({ proximityAtrMult: v })}
            />
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              前期高低点由分型确认（与 V1 同口径）。容差调大 → 距参考位
              较远的冲击也算到位、信号变多；调小 → 只认贴着关口的拒绝。
            </p>
          </div>

          <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
            <div className="text-xs font-medium text-[var(--text-secondary)]">
              拒绝形态
            </div>
            <NumberField
              label="上攻失败深度（×ATR）"
              value={pivot.wickAtrMult ?? 0.8}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) => store.updatePivotV2({ wickAtrMult: v })}
            />
            <NumberField
              label="多K上攻窗口（根）"
              value={pivot.attackWindow ?? 3}
              min={1}
              max={20}
              onChange={(v) => store.updatePivotV2({ attackWindow: v })}
            />
            <NumberField
              label="同侧信号间隔（根）"
              value={pivot.cooldown ?? 5}
              min={0}
              max={200}
              onChange={(v) => store.updatePivotV2({ cooldown: v })}
            />
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              失败深度 = 窗口最高价 − 收盘价（单K长上影线 / 多K累计冲高回落
              共用此口径）。调大 → 只认惨烈的失败；调小 → 轻微回落也算。
              间隔防同一关口连续刷屏，调小信号变密。
            </p>
          </div>

          <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
            <div className="text-xs font-medium text-[var(--text-secondary)]">
              量能确认（二选一满足）
            </div>
            <NumberField
              label="急速放大下限（×均量）"
              value={pivot.volExpandRatio ?? 1.5}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) => store.updatePivotV2({ volExpandRatio: v })}
            />
            <NumberField
              label="急速萎缩上限（×均量）"
              value={pivot.volShrinkRatio ?? 0.7}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) => store.updatePivotV2({ volShrinkRatio: v })}
            />
            <NumberField
              label="均量窗口"
              value={pivot.volMaPeriod ?? 20}
              min={2}
              max={200}
              onChange={(v) => store.updatePivotV2({ volMaPeriod: v })}
            />
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              放量拒绝：触发 bar 量 ≥ 均量×下限（上影/下影配急速放量 = 吸收）；
              缩量失败：量 ≤ 均量×上限（上攻/下攻无后续 = 衰竭）。两者满足其一
              即触发；量能数据缺失时降级为纯形态。各数据源成交量口径不同，
              换品种/周期后先看信号密度再微调。
            </p>
          </div>

          <NumberField
            label="ATR 周期"
            value={pivot.atrPeriod ?? 14}
            min={2}
            max={100}
            onChange={(v) => store.updatePivotV2({ atrPeriod: v })}
          />

          <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={pivot.markInvalidated !== false}
                onChange={(e) =>
                  store.updatePivotV2({ markInvalidated: e.target.checked })
                }
                className="accent-[var(--primary)]"
              />
              假信号标记（默认开）
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={pivot.hideInvalidated === true}
                onChange={(e) =>
                  store.updatePivotV2({ hideInvalidated: e.target.checked })
                }
                className="accent-[var(--primary)]"
              />
              隐藏假信号箭头（默认灰显带 ✕）
            </label>
            <NumberField
              label="突破缓冲（×ATR）"
              value={pivot.invalidateAtrMult ?? 0}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) => store.updatePivotV2({ invalidateAtrMult: v })}
            />
            <ColorField
              label="假信号箭头颜色"
              value={pivot.invalidatedColor ?? "#6b7280"}
              onChange={(c) => store.updatePivotV2({ invalidatedColor: c })}
            />
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              参考位被突破（含缓冲）即判假：箭头变灰、文案带 ✕——空信号被
              涨破 = 假空，多信号被跌破 = 假多。缓冲调大可豁免插针式浅突破；
              0（默认）与止损被打穿的口径一致。
            </p>
          </div>

          <ColorField
            label="做多箭头颜色"
            value={pivot.longColor}
            highlight="arrowLong"
            onHighlight={onHighlight}
            onChange={(c) => store.updatePivotV2({ longColor: c })}
          />
          <ColorField
            label="做空箭头颜色"
            value={pivot.shortColor}
            highlight="arrowShort"
            onHighlight={onHighlight}
            onChange={(c) => store.updatePivotV2({ shortColor: c })}
          />

          <div className="flex gap-2 pt-1 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={() => {
                const v1 = store.config.pivot ?? DEFAULT_INDICATOR_CONFIG.pivot
                store.updatePivotV2({
                  left: Math.max(2, v1.left),
                  right: Math.max(2, v1.right),
                  longColor: v1.longColor,
                  shortColor: v1.shortColor,
                })
              }}
              className="flex-1 px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              参数对齐 V1
            </button>
            <button
              type="button"
              onClick={() =>
                store.updatePivotV2({
                  ...DEFAULT_INDICATOR_CONFIG.pivotV2,
                  enabled: pivot.enabled,
                })
              }
              className="flex-1 px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              恢复默认参数
            </button>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] -mt-1 leading-relaxed">
            「参数对齐 V1」把前期高低点的确认根数和箭头颜色照抄 V1 当前值
            （拒绝形态、量能、假信号等 V2 专属项不动）。「恢复默认参数」把
            本页全部参数重置为出厂值（保留启用开关，不影响其它指标）。
          </p>
        </div>
      )}
    </div>
  )
}
