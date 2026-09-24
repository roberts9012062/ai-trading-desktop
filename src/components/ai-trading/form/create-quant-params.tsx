"use client"

/** 创建量化任务：策略选择与参数区 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SwingV2Params } from "@/components/backtest/quant-params-swing-v2"
import { StrengthEntryParams } from "@/components/backtest/quant-params-strength"
import { StrengthEntryV2Params } from "@/components/backtest/quant-params-strength-v2"
import {
  QUANT_KIND_OPTIONS,
  type QuantKind,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import { FactorKindParams } from "./factor-kind-params"

interface CreateQuantParamsProps {
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  symbol: string
  /** 任务主 K 线周期：过滤波段第二周期选项（避免与主周期相同） */
  timeframe?: string
  /** 选中收藏因子时回填品种/周期（仅 factor 策略触发） */
  onApplyFactorMeta?: (symbol: string | null, timeframe: string | null) => void
}

const SWING_RES_TFS = ["1m", "5m", "15m", "30m", "60m", "1d"] as const

/** 策略类型按钮 + 参数输入 */
export function CreateQuantParams({
  quant,
  onQuant,
  symbol,
  timeframe,
  onApplyFactorMeta,
}: CreateQuantParamsProps): React.JSX.Element {
  return (
    <>
      <div className="space-y-1">
        <Label>策略类型</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {QUANT_KIND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={opt.disabled === true}
              title={opt.disabled === true ? "该策略暂停使用" : undefined}
              className={`h-9 rounded-md border text-xs transition-colors ${
                opt.disabled === true
                  ? "cursor-not-allowed border-[var(--border)] text-[var(--text-muted)] opacity-50"
                  : quant.quantKind === opt.value
                    ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              }`}
              onClick={() => onQuant({ ...quant, quantKind: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          策略参数
        </div>
        <KindParams
          quant={quant}
          onQuant={onQuant}
          symbol={symbol}
          timeframe={timeframe}
          onApplyFactorMeta={onApplyFactorMeta}
        />
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          {hintFor(quant.quantKind)}
        </p>
      </div>
    </>
  )
}

export function KindParams({
  quant,
  onQuant,
  symbol,
  timeframe,
  onApplyFactorMeta,
}: CreateQuantParamsProps): React.JSX.Element {
  if (quant.quantKind === "n_breakout") {
    return (
      <Field
        label="回看周期 N"
        type="number"
        min={2}
        value={quant.lookback}
        onChange={(v) => onQuant({ ...quant, lookback: Math.max(2, v) })}
      />
    )
  }
  if (quant.quantKind === "ma_cross") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="快线"
          type="number"
          min={1}
          value={quant.fastPeriod}
          onChange={(v) => onQuant({ ...quant, fastPeriod: Math.max(1, v) })}
        />
        <Field
          label="慢线"
          type="number"
          min={2}
          value={quant.slowPeriod}
          onChange={(v) => onQuant({ ...quant, slowPeriod: Math.max(2, v) })}
        />
      </div>
    )
  }
  if (quant.quantKind === "macd_cross") {
    return (
      <div className="grid grid-cols-3 gap-2">
        <Field
          label="快"
          type="number"
          min={2}
          value={quant.macdFast}
          onChange={(v) => onQuant({ ...quant, macdFast: Math.max(2, v) })}
        />
        <Field
          label="慢"
          type="number"
          min={3}
          value={quant.macdSlow}
          onChange={(v) => onQuant({ ...quant, macdSlow: Math.max(3, v) })}
        />
        <Field
          label="信号"
          type="number"
          min={2}
          value={quant.macdSignal}
          onChange={(v) => onQuant({ ...quant, macdSignal: Math.max(2, v) })}
        />
      </div>
    )
  }
  if (quant.quantKind === "kdj_cross") {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <Field
            label="N"
            type="number"
            min={2}
            value={quant.kdjN}
            onChange={(v) => onQuant({ ...quant, kdjN: Math.max(2, v) })}
          />
          <Field
            label="K"
            type="number"
            min={2}
            value={quant.kdjK}
            onChange={(v) => onQuant({ ...quant, kdjK: Math.max(2, v) })}
          />
          <Field
            label="D"
            type="number"
            min={2}
            value={quant.kdjD}
            onChange={(v) => onQuant({ ...quant, kdjD: Math.max(2, v) })}
          />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={quant.kdjUseZone}
            onChange={(e) =>
              onQuant({ ...quant, kdjUseZone: e.target.checked })
            }
          />
          仅超卖金叉 / 超买死叉
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
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="左分型根数"
            type="number"
            min={1}
            value={quant.swingLeft}
            onChange={(v) => onQuant({ ...quant, swingLeft: Math.max(1, v) })}
          />
          <Field
            label="右侧确认根数"
            type="number"
            min={2}
            value={quant.swingRight}
            onChange={(v) => onQuant({ ...quant, swingRight: Math.max(2, v) })}
          />
        </div>
        <Field
          label="盘中预确认最少右侧根数"
          type="number"
          min={1}
          value={quant.swingMinRightLive}
          onChange={(v) =>
            onQuant({
              ...quant,
              swingMinRightLive: Math.min(
                quant.swingRight,
                Math.max(1, v),
              ),
            })
          }
        />
        <div className="grid grid-cols-3 gap-2">
          <Field
            label="最小幅度%"
            type="number"
            min={0}
            value={quant.swingMinAmplitude}
            onChange={(v) =>
              onQuant({ ...quant, swingMinAmplitude: Math.max(0, v) })
            }
          />
          <Field
            label="ATR 倍数"
            type="number"
            min={0}
            value={quant.swingMinAtrMult}
            onChange={(v) =>
              onQuant({ ...quant, swingMinAtrMult: Math.max(0, v) })
            }
          />
          <Field
            label="ATR 周期"
            type="number"
            min={1}
            value={quant.swingAtrPeriod}
            onChange={(v) =>
              onQuant({ ...quant, swingAtrPeriod: Math.max(1, v) })
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="信号新鲜度（根）"
            type="number"
            min={1}
            value={quant.swingMaxAge}
            onChange={(v) =>
              onQuant({
                ...quant,
                swingMaxAge: Math.max(1, Math.min(20, v)),
              })
            }
          />
          <div className="space-y-1">
            <Label className="text-[11px]">第二周期（共振）</Label>
            <select
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs"
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
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px]">进场模式</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs"
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
            <div className="space-y-1">
              <Label className="text-[11px]">平仓模式</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs"
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
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">信号K线止损</Label>
            <select
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs"
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
            <Field
              label="止损追加点数（0-5）"
              type="number"
              min={0}
              value={quant.swingStopBuffer}
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
              <Field
                label="反手止损百分比（0.1-10，0=信号K线另一侧极值）"
                type="number"
                min={0}
                value={quant.swingReverseStopPct}
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
      </div>
    )
  }
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
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field
        label="周期"
        type="number"
        min={5}
        value={quant.bandPeriod}
        onChange={(v) => onQuant({ ...quant, bandPeriod: Math.max(5, v) })}
      />
      <div className="space-y-1">
        <Label className="text-[11px]">标准差</Label>
        <Input
          type="number"
          min={0.5}
          step={0.1}
          value={quant.bandStd}
          onChange={(e) =>
            onQuant({
              ...quant,
              bandStd: Math.max(0.5, Number(e.target.value) || 2),
            })
          }
        />
      </div>
    </div>
  )
}

function Field({
  label,
  type,
  min,
  value,
  onChange,
}: {
  label: string
  type: "number"
  min: number
  value: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <Input
        type={type}
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || min)}
      />
    </div>
  )
}

function hintFor(kind: QuantKind): string {
  if (kind === "n_breakout") {
    return "收盘突破前 N 根最高 → 买多；跌破最低 → 卖空。反向持仓先平。"
  }
  if (kind === "ma_cross") {
    return "金叉（快线上穿慢线）→ 买多；死叉 → 卖空。"
  }
  if (kind === "macd_cross") {
    return "DIF 上穿 DEA → 买多；下穿 → 卖空。默认 12/26/9。"
  }
  if (kind === "kdj_cross") {
    return "K 上穿 D → 买多；下穿 → 卖空。可选仅在超买超卖区生效。"
  }
  if (kind === "swing_pivot") {
    return "波谷反转 → 买多；波峰反转 → 卖空。信号新鲜度（默认 3 根）：仅最近 N 根内出现的信号才开仓/反向平仓。盘中预确认最少右侧根数（默认 1）：右侧 1 根已收盘即出预确认信号并触发交易，与图表波段信号同口径；设为与右侧确认根数相同则只出正式确认。选第二周期后可开多频共振（短周期信号先现并保持新鲜，等长周期同向信号出现才下单；平仓同理）；信号K线止损以信号那根 K 线的最高/最低为止损锚，可追加 0-5 点。"
  }
  if (kind === "swing_pivot_v2") {
    return "V2 量价拒绝：前期高点出现放量上影拒绝或缩量多K上攻失败 → 做空；前期低点镜像 → 做多。参考位被突破 = 假信号，不再依其开仓。量能两条阈值之间的常态量不触发。"
  }
  if (kind === "strength_entry") {
    return "0-100 强弱指标三档进场（只做多）：波段=顺势上穿；反弹=弱区回升；超跌=极低位拐头。强弱值跌破平多阈值离场；不出空信号。参数与图表强弱副图同口径。"
  }
  if (kind === "strength_entry_v2") {
    return "0-100 强弱形态 V2 六档双向：底部/顶部衰竭=段谷/峰动能枯竭预警；反弹/破位=regime 翻转确认；中继=回调不破位再顺势。反向信号或 regime 翻转平仓。参数与图表 V2 副图同口径。"
  }
  if (kind === "factor") {
    return "优先从收藏下拉选择；也可粘贴因子实验室 tokens。公式 → tanh 仓位意图。"
  }
  return "触及下轨 → 买多；触及上轨 → 卖空；回到中轨 → 平仓。"
}
