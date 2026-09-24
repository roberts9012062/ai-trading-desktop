"use client"

/** 回测表单：策略类型与参数 */

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  QUANT_KIND_OPTIONS,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import { FactorKindParams } from "@/components/ai-trading/form/factor-kind-params"
import { SwingV2Params } from "./quant-params-swing-v2"
import { StrengthEntryParams } from "./quant-params-strength"
import { StrengthEntryV2Params } from "./quant-params-strength-v2"
import type { AIModel } from "@/types"

export type { QuantParamsState }

interface StrategySectionProps {
  mode: "quant" | "ai"
  onMode: (m: "quant" | "ai") => void
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  models: AIModel[]
  modelRowId: string
  onModel: (id: string) => void
  symbol: string
  /** 主 K 线周期：过滤波段第二周期选项 */
  timeframe?: string
  /** 选中收藏因子时回填品种/周期 */
  onApplyFactorMeta: (symbol: string | null, timeframe: string | null) => void
}

const SWING_RES_TFS = ["1m", "5m", "15m", "30m", "60m", "1d"] as const

/** 策略类型切换 + 参数 */
export function StrategySection({
  mode,
  onMode,
  quant,
  onQuant,
  models,
  modelRowId,
  onModel,
  symbol,
  timeframe,
  onApplyFactorMeta,
}: StrategySectionProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button
          type="button"
          variant={mode === "quant" ? "default" : "outline"}
          size="sm"
          onClick={() => onMode("quant")}
        >
          量化策略
        </Button>
        <Button
          type="button"
          variant={mode === "ai" ? "default" : "outline"}
          size="sm"
          onClick={() => onMode("ai")}
        >
          AI 自动交易
        </Button>
      </div>
      {mode === "quant" && (
        <>
          <div className="flex flex-wrap gap-2">
            {QUANT_KIND_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                size="sm"
                disabled={opt.disabled === true}
                title={opt.disabled === true ? "该策略暂停使用" : undefined}
                variant={
                  quant.quantKind === opt.value ? "default" : "outline"
                }
                className={
                  opt.disabled === true
                    ? "cursor-not-allowed opacity-50"
                    : undefined
                }
                onClick={() => onQuant({ ...quant, quantKind: opt.value })}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <QuantParamFields
            quant={quant}
            onQuant={onQuant}
            symbol={symbol}
            timeframe={timeframe}
            onApplyFactorMeta={onApplyFactorMeta}
          />
        </>
      )}
      {mode === "ai" && (
        <div className="space-y-2">
          <Label>AI 模型</Label>
          <select
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
            value={modelRowId}
            onChange={(e) => onModel(e.target.value)}
          >
            {models.length === 0 && <option value="">暂无模型</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name || m.model_id}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-[var(--text-muted)]">
            AI 回测对 K 线抽样调用模型（最多约 24 次）
          </p>
        </div>
      )}
    </div>
  )
}

/** 各量化策略参数表单 */
function QuantParamFields({
  quant,
  onQuant,
  symbol,
  timeframe,
  onApplyFactorMeta,
}: {
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  symbol: string
  /** 主 K 线周期：过滤波段第二周期选项 */
  timeframe?: string
  onApplyFactorMeta: (symbol: string | null, timeframe: string | null) => void
}): React.JSX.Element {
  if (quant.quantKind === "factor") {
    return (
      <FactorKindParams
        quant={quant}
        onQuant={onQuant}
        symbol={symbol}
        onApplyMeta={onApplyFactorMeta}
      />
    )
  }
  if (quant.quantKind === "n_breakout") {
    return (
      <div className="space-y-2">
        <Label>突破回看 N</Label>
        <Input
          type="number"
          min={2}
          value={quant.lookback}
          onChange={(e) =>
            onQuant({ ...quant, lookback: Number(e.target.value || 20) })
          }
        />
      </div>
    )
  }
  if (quant.quantKind === "ma_cross") {
    return (
      <div className="grid grid-cols-2 gap-3">
        <NumField
          label="快线"
          value={quant.fastPeriod}
          min={1}
          onChange={(v) => onQuant({ ...quant, fastPeriod: v })}
        />
        <NumField
          label="慢线"
          value={quant.slowPeriod}
          min={2}
          onChange={(v) => onQuant({ ...quant, slowPeriod: v })}
        />
      </div>
    )
  }
  if (quant.quantKind === "macd_cross") {
    return (
      <div className="grid grid-cols-3 gap-2">
        <NumField
          label="快线"
          value={quant.macdFast}
          min={2}
          onChange={(v) => onQuant({ ...quant, macdFast: v })}
        />
        <NumField
          label="慢线"
          value={quant.macdSlow}
          min={3}
          onChange={(v) => onQuant({ ...quant, macdSlow: v })}
        />
        <NumField
          label="信号"
          value={quant.macdSignal}
          min={2}
          onChange={(v) => onQuant({ ...quant, macdSignal: v })}
        />
      </div>
    )
  }
  if (quant.quantKind === "kdj_cross") {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <NumField
            label="N"
            value={quant.kdjN}
            min={2}
            onChange={(v) => onQuant({ ...quant, kdjN: v })}
          />
          <NumField
            label="K"
            value={quant.kdjK}
            min={2}
            onChange={(v) => onQuant({ ...quant, kdjK: v })}
          />
          <NumField
            label="D"
            value={quant.kdjD}
            min={2}
            onChange={(v) => onQuant({ ...quant, kdjD: v })}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={quant.kdjUseZone}
            onChange={(e) =>
              onQuant({ ...quant, kdjUseZone: e.target.checked })
            }
          />
          仅超卖区金叉 / 超买区死叉
        </label>
      </div>
    )
  }
  if (quant.quantKind === "swing_pivot_v2") {
    return <SwingV2Params quant={quant} onQuant={onQuant} />
  }
  if (quant.quantKind === "strength_entry") {
    return <StrengthEntryParams quant={quant} onQuant={onQuant} />
  }
  if (quant.quantKind === "strength_entry_v2") {
    return <StrengthEntryV2Params quant={quant} onQuant={onQuant} />
  }
  if (quant.quantKind === "swing_pivot") {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <NumField
            label="左分型根数"
            value={quant.swingLeft}
            min={1}
            onChange={(v) => onQuant({ ...quant, swingLeft: v })}
          />
          <NumField
            label="右侧确认根数"
            value={quant.swingRight}
            min={2}
            onChange={(v) => onQuant({ ...quant, swingRight: v })}
          />
        </div>
        <NumField
          label="盘中预确认最少右侧根数"
          value={quant.swingMinRightLive}
          min={1}
          onChange={(v) =>
            onQuant({
              ...quant,
              swingMinRightLive: Math.min(quant.swingRight, Math.max(1, v)),
            })
          }
        />
        <div className="grid grid-cols-3 gap-2">
          <NumField
            label="最小幅度%"
            value={quant.swingMinAmplitude}
            min={0}
            onChange={(v) => onQuant({ ...quant, swingMinAmplitude: v })}
          />
          <NumField
            label="ATR 倍数"
            value={quant.swingMinAtrMult}
            min={0}
            onChange={(v) => onQuant({ ...quant, swingMinAtrMult: v })}
          />
          <NumField
            label="ATR 周期"
            value={quant.swingAtrPeriod}
            min={1}
            onChange={(v) => onQuant({ ...quant, swingAtrPeriod: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumField
            label="信号新鲜度（根）"
            value={quant.swingMaxAge}
            min={1}
            onChange={(v) =>
              onQuant({
                ...quant,
                swingMaxAge: Math.max(1, Math.min(20, v)),
              })
            }
          />
          <div className="space-y-2">
            <Label>第二周期（共振）</Label>
            <select
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={quant.swingResonanceTf}
              onChange={(e) =>
                onQuant({ ...quant, swingResonanceTf: e.target.value })
              }
            >
              <option value="">不启用（单周期）</option>
              {SWING_RES_TFS.filter((t) => t !== timeframe).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
        {quant.swingResonanceTf && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>进场模式</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={quant.swingEntryMode}
                onChange={(e) =>
                  onQuant({ ...quant, swingEntryMode: e.target.value })
                }
              >
                <option value="single">单频（主周期信号即下单）</option>
                <option value="resonance">
                  多频共振（短周期先现，等长周期确认）
                </option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>平仓模式</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={quant.swingExitMode}
                onChange={(e) =>
                  onQuant({ ...quant, swingExitMode: e.target.value })
                }
              >
                <option value="single">单频（主周期反向信号即平）</option>
                <option value="resonance">多频共振（双周期反向确认）</option>
              </select>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>信号K线止损</Label>
            <select
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={quant.swingStopMode}
              onChange={(e) =>
                onQuant({ ...quant, swingStopMode: e.target.value })
              }
            >
              <option value="off">关闭</option>
              <option value="single">主周期信号K线极值</option>
              {quant.swingResonanceTf && (
                <option value="resonance">第二周期信号K线极值</option>
              )}
            </select>
          </div>
          {quant.swingStopMode !== "off" && (
            <NumField
              label="止损追加点数（0-5）"
              value={quant.swingStopBuffer}
              min={0}
              onChange={(v) =>
                onQuant({
                  ...quant,
                  swingStopBuffer: Math.max(0, Math.min(5, v)),
                })
              }
            />
          )}
        </div>
        {quant.swingStopMode !== "off" && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={quant.swingReverseOnStop}
                onChange={(e) =>
                  onQuant({ ...quant, swingReverseOnStop: e.target.checked })
                }
              />
              止损后自动反手（做空失败马上转多，切换波段节奏）
            </label>
            {quant.swingReverseOnStop && (
              <NumField
                label="反手止损百分比（0.1-10，0=信号K线另一侧极值）"
                value={quant.swingReverseStopPct}
                min={0}
                onChange={(v) =>
                  onQuant({
                    ...quant,
                    swingReverseStopPct: Math.max(0, Math.min(10, v)),
                  })
                }
              />
            )}
          </div>
        )}
        <p className="text-[11px] text-[var(--text-muted)]">
          波谷反转 → 买多；波峰反转 → 卖空。信号新鲜度（默认 3 根）：仅最近 N
          根内出现的信号才开仓/反向平仓。盘中预确认最少右侧根数（默认 1）与图表波段信号同口径：右侧
          1 根已收盘即出预确认信号并触发交易；设为与右侧确认根数相同则只出正式确认。
          第二周期共振与信号K线止损与实盘任务同口径（回测第二周期由主周期K线重采样）。
        </p>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <NumField
        label="周期"
        value={quant.bandPeriod}
        min={5}
        onChange={(v) => onQuant({ ...quant, bandPeriod: v })}
      />
      <div className="space-y-2">
        <Label>标准差倍数</Label>
        <Input
          type="number"
          min={0.5}
          step={0.1}
          value={quant.bandStd}
          onChange={(e) =>
            onQuant({ ...quant, bandStd: Number(e.target.value || 2) })
          }
        />
      </div>
    </div>
  )
}

function NumField({
  label,
  value,
  min,
  onChange,
}: {
  label: string
  value: number
  min: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value || min))}
      />
    </div>
  )
}
