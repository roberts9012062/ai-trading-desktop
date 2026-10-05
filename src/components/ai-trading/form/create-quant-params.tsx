"use client"

/** 创建量化任务：策略选择与参数区 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SwingV2Params } from "@/components/backtest/quant-params-swing-v2"
import { StrengthEntryParams } from "@/components/backtest/quant-params-strength"
import { StrengthEntryV2Params } from "@/components/backtest/quant-params-strength-v2"
import {
  type QuantKind,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import { FactorKindParams } from "./factor-kind-params"
import { ShortlineKindParams } from "./shortline-kind-params"
import { StrategyTypePicker } from "./strategy-type-picker"

interface CreateQuantParamsProps {
  /** 主周期（专业波段第二周期标签换算用） */
  timeframe?: string
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  symbol: string
  /** 选中收藏因子时回填品种/周期（仅 factor 策略触发） */
  onApplyFactorMeta?: (symbol: string | null, timeframe: string | null) => void
}

/** 策略类型按钮 + 参数输入 */
export function CreateQuantParams({
  quant,
  onQuant,
  symbol,
  onApplyFactorMeta,
  timeframe,
}: CreateQuantParamsProps): React.JSX.Element {
  return (
    <>
      <div className="space-y-1">
        <Label>策略类型</Label>
        <StrategyTypePicker value={quant.quantKind} onChange={quantKind => onQuant({ ...quant, quantKind })} />
      </div>
      <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          策略参数
        </div>
        <KindParams
          quant={quant}
          onQuant={onQuant}
          symbol={symbol}
          onApplyFactorMeta={onApplyFactorMeta}
          timeframe={timeframe}
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
  onApplyFactorMeta,
  timeframe,
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
  if (quant.quantKind === "swing_pro") {
    return <ProSwingParams quant={quant} onQuant={onQuant} timeframe={timeframe} />
  }
  if (quant.quantKind === "swing_pivot") {
    return (
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={quant.swingAlternate !== false}
            onChange={(e) => onQuant({ ...quant, swingAlternate: e.target.checked })}
            className="accent-[var(--primary)]" />
          多空交替（与图表波段设置一致）
        </label>
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
  if (quant.quantKind === "shortline_factor") {
    // 短线因子：收藏源=短线因子库（桌面编码,与因子收藏严格分流——
    // 两套特征表 52 号后同号不同义,混用必"数据不足或因子无效"）
    // + 短线专属参数（cadence/预热/决策闸门/日亏）
    return (
      <div className="space-y-2">
        <ShortlineKindParams
          quant={quant}
          onQuant={onQuant}
          symbol={symbol}
          onApplyMeta={onApplyFactorMeta}
        />
        <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            短线参数（打分节奏 ≠ 交易节奏：阈值/确认/频率闸门）
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">打分节奏（秒）</Label>
            <div className="flex gap-1 flex-wrap">
              {[3, 5, 10, 15, 30, 60].map((sOpt) => (
                <button
                  key={sOpt}
                  type="button"
                  onClick={() => onQuant({ ...quant, slCadenceSec: sOpt })}
                  className={`px-2 h-7 rounded-md border text-xs transition-colors ${
                    quant.slCadenceSec === sOpt
                      ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  {sOpt}s
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="预热 K 线根数"
              type="number"
              min={60}
              max={2000}
              value={quant.slWarmupBars}
              onChange={(v) =>
                onQuant({ ...quant, slWarmupBars: Math.min(2000, Math.max(60, Math.round(v))) })
              }
            />
            <Field
              label="开仓阈值"
              type="number"
              min={0.05}
              max={0.9}
              step={0.05}
              value={quant.slThreshold}
              onChange={(v) => onQuant({ ...quant, slThreshold: v })}
            />
            <Field
              label="确认步数"
              type="number"
              min={1}
              max={50}
              value={quant.slConfirmSteps}
              onChange={(v) =>
                onQuant({ ...quant, slConfirmSteps: Math.min(50, Math.max(1, Math.round(v))) })
              }
            />
            <Field
              label="每小时动作上限"
              type="number"
              min={1}
              max={60}
              value={quant.slMaxPerHour}
              onChange={(v) =>
                onQuant({ ...quant, slMaxPerHour: Math.min(60, Math.max(1, Math.round(v))) })
              }
            />
            <Field
              label="日亏停机（USDT）"
              type="number"
              min={1}
              value={quant.slDailyLoss}
              onChange={(v) => onQuant({ ...quant, slDailyLoss: Math.max(1, v) })}
            />
          </div>
        </div>
      </div>
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
  max,
  step,
  value,
  onChange,
}: {
  label: string
  type: "number"
  min: number
  max?: number
  step?: number
  value: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <Input
        type={type}
        min={min}
        max={max}
        step={step}
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
    return "波谷反转 → 买多；波峰反转 → 卖空。盘中预确认右侧根数包含当前未收盘K线，凑够即可触发。开仓依据的波谷被跌破或波峰被突破时立即提交市价止损，成交确认后等待新枢轴，同一枢轴不重复开仓。设为与右侧确认根数相同，则等待这些K线全部收盘才触发正式信号。"
  }
  if (kind === "swing_pivot_v2") {
    return "V2 量价拒绝：前期高点出现放量上影拒绝或缩量多K上攻失败 → 做空；前期低点镜像 → 做多。参考位被突破 = 假信号，不再依其开仓。量能两条阈值之间的常态量不触发。"
  }
  if (kind === "swing_pro") {
    return "专业波段：枢轴信号须出现在最近 N 根（默认 3）K 线内才可下单/平仓；可选第二周期做共振——短周期信号先出标记，长周期同向信号出现才成交（短等长）；止损锚定信号K线极值并追加 0~5%。反向信号平仓同理分单频/共振。"
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


/** 专业波段（swing_pro）参数：双周期共振 / 单频 + 信号K线极值止损（回测/合成面板复用） */
export function ProSwingParams(props: {
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  /** 主周期（第二周期选项换算成绝对周期显示，如 5m×3 → 15 分钟） */
  timeframe?: string
}): React.JSX.Element {
  const { quant: q, onQuant, timeframe } = props
  const tfMin: Record<string, number> = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": 1440,
  }
  // 第二周期候选：×2/×3/×4/×6/×12（仅显示对当前主周期有意义的档位由调用方控制，
  // 这里全量给出并按倍数标注）
  const mainTf = (timeframe || "").toLowerCase()
  // 第二周期 = 标准 K 线周期档（与 K 线图周期一致），排除主周期自身；
  // 可大于也可小于主周期——两周期中较小者为先导（快信号），较大者为确认（共振）
  const TF_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "1m", label: "1 分钟" },
    { value: "5m", label: "5 分钟" },
    { value: "15m", label: "15 分钟" },
    { value: "30m", label: "30 分钟" },
    { value: "60m", label: "1 小时" },
    { value: "1d", label: "1 天" },
  ].filter((o) => o.value !== mainTf)
  const modeOptions = [
    { value: "single", label: "单频" },
    { value: "resonance", label: "共振" },
  ] as const
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="左分型根数"
          type="number"
          min={1}
          value={q.swingLeft}
          onChange={(v) => onQuant({ ...q, swingLeft: Math.max(1, v) })}
        />
        <Field
          label="右侧确认根数"
          type="number"
          min={2}
          value={q.swingRight}
          onChange={(v) => onQuant({ ...q, swingRight: Math.max(2, v) })}
        />
      </div>
      <Field
        label="盘中预确认最少右侧根数（1–右侧确认根数，1=最快出信号）"
        type="number"
        min={1}
        max={q.swingRight}
        value={q.swingMinRightLive}
        onChange={(v) =>
          onQuant({
            ...q,
            swingMinRightLive: Math.min(q.swingRight, Math.max(1, Math.round(v))),
          })
        }
      />
      <p className="text-[10px] text-[var(--text-muted)] -mt-1">
        与枢轴波段同口径：右侧凑满该根数即出预确认信号并触发交易；设为与右侧确认根数相同则只出正式确认（更稳但更慢）。
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="最小幅度%"
          type="number"
          min={0}
          step={0.1}
          value={q.swingMinAmplitude}
          onChange={(v) => onQuant({ ...q, swingMinAmplitude: v })}
        />
        <Field
          label="最小ATR倍数"
          type="number"
          min={0}
          step={0.1}
          value={q.swingMinAtrMult}
          onChange={(v) => onQuant({ ...q, swingMinAtrMult: v })}
        />
      </div>
      <Field
        label="ATR 周期"
        type="number"
        min={2}
        value={q.swingAtrPeriod}
        onChange={(v) => onQuant({ ...q, swingAtrPeriod: Math.max(2, Math.round(v)) })}
      />
      <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
        <div className="text-[11px] font-medium text-[var(--text-secondary)]">
          双周期共振（第二周期选分钟档，大于主周期）
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[11px] text-[var(--text-muted)]">第二周期</label>
            <select
              className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={q.proHtfTf}
              onChange={(e) => onQuant({ ...q, proHtfTf: e.target.value })}
            >
              <option value="">无（单周期）</option>
              {TF_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {mainTf && o.value !== mainTf ? "（共振）" : ""}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="信号新鲜窗口（根）"
            type="number"
            min={1}
            max={10}
            value={q.proSignalWindow}
            onChange={(v) =>
              onQuant({
                ...q,
                proSignalWindow: Math.max(1, Math.min(10, Math.round(v))),
              })
            }
          />
        </div>
        <p className="text-[10px] text-[var(--text-muted)]">
          信号须出现在最近 N 根 K 线内（默认 3）才可下单/平仓。第二周期是标准 K 线周期档，
          可大于也可小于主周期（如主 15 分钟 + 第二 5 分钟）：两周期中<b>较小者为先导</b>（快信号，
          出现即标记），<b>较大者为确认</b>（共振时等它同向才成交）。注意：AI 生成K线回放仅支持
          第二周期 ≥ 主周期（合成 K 线无法拆出更细周期，选更小时该回放自动按单频处理）。
        </p>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label className="text-[11px] text-[var(--text-muted)]">下单模式</label>
            <select
              className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={q.proConfirmMode}
              onChange={(e) =>
                onQuant({
                  ...q,
                  proConfirmMode: e.target.value as "single" | "resonance",
                })
              }
            >
              {modeOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-[var(--text-muted)]">反向平仓</label>
            <select
              className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={q.proExitMode}
              onChange={(e) =>
                onQuant({ ...q, proExitMode: e.target.value as "single" | "resonance" })
              }
            >
              {modeOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-[var(--text-muted)]">止损锚</label>
            <select
              className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={q.proStopMode}
              onChange={(e) =>
                onQuant({ ...q, proStopMode: e.target.value as "single" | "resonance" })
              }
            >
              {modeOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <Field
          label="止损追加点数 %（0-5，锚定信号K线高/低点外扩）"
          type="number"
          min={0}
          max={5}
          step={0.5}
          value={q.proStopExtraPct}
          onChange={(v) =>
            onQuant({ ...q, proStopExtraPct: Math.max(0, Math.min(5, v)) })
          }
        />
        <p className="text-[10px] text-[var(--text-muted)]">
          下单：单频=主周期信号新鲜即下单；共振=短周期先出信号标记、长周期同向出现才成交。
          止损锚：单频=主周期信号K线极值；共振=长周期信号K线极值（更稳）。
        </p>
        <label className="flex items-center gap-2 text-xs cursor-pointer pt-1">
          <input
            type="checkbox"
            checked={q.proStopReverse}
            onChange={(e) => onQuant({ ...q, proStopReverse: e.target.checked })}
            className="rounded border-[var(--border)]"
          />
          止损后自动反手（做空止损→立即做多；反手仓止损后不再反手）
        </label>
        {q.proStopReverse && (
          <>
            <Field
              label="反手止损 %（反手仓不用信号锚，按百分比止损）"
              type="number"
              min={0.1}
              max={20}
              step={0.1}
              value={q.proReverseStopPct}
              onChange={(v) =>
                onQuant({
                  ...q,
                  proReverseStopPct: Math.max(0.1, Math.min(20, v)),
                })
              }
            />
            <p className="text-[10px] text-[var(--text-muted)]">
              信号仓止损沿用上方信号K线锚；被止损后同根 K 线立即反向开仓，
              反手仓以开仓价 ± 此百分比设止损，避免沿用信号锚导致止损过宽。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
