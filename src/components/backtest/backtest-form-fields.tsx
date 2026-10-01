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
import { ProSwingParams } from "@/components/ai-trading/form/create-quant-params"
import { SwingV2Params } from "./quant-params-swing-v2"
import { StrengthEntryParams } from "./quant-params-strength"
import { StrengthEntryV2Params } from "./quant-params-strength-v2"
import type { AIModel } from "@/types"

export type { QuantParamsState }

interface StrategySectionProps {
  /** 主周期（专业波段第二周期标签换算用） */
  timeframe?: string
  mode: "quant" | "ai"
  onMode: (m: "quant" | "ai") => void
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  models: AIModel[]
  modelRowId: string
  onModel: (id: string) => void
  symbol: string
  /** 选中收藏因子时回填品种/周期 */
  onApplyFactorMeta: (symbol: string | null, timeframe: string | null) => void
}

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
  onApplyFactorMeta,
  timeframe,
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
            {QUANT_KIND_OPTIONS.filter((o) => o.value !== "shortline_factor").map((opt) => (
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
            onApplyFactorMeta={onApplyFactorMeta}
            timeframe={timeframe}
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
  onApplyFactorMeta,
  timeframe,
}: {
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  symbol: string
  onApplyFactorMeta: (symbol: string | null, timeframe: string | null) => void
  timeframe?: string
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
  if (quant.quantKind === "swing_pro") {
    return <ProSwingParams quant={quant} onQuant={onQuant} timeframe={timeframe} />
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
        <p className="text-[11px] text-[var(--text-muted)]">
          波谷反转 → 买多；波峰反转 → 卖空。盘中预确认最少右侧根数（默认 1）与图表波段信号同口径：右侧 1 根已收盘即出预确认信号并触发交易；设为与右侧确认根数相同则只出正式确认。预确认信号会随行情破坏而消失。
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
