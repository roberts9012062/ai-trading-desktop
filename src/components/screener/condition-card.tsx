"use client"

/**
 * 筛选条件卡片 —— 单个指标条件的操作类型 / 参数 / 窗口编辑
 */

import { Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  COND_TYPE_META,
  opUsesWindow,
  conditionSummary,
  type ScreenerCondType,
  type ScreenerCondition,
} from "@/lib/screener-api"

const WINDOW_OPTIONS = [1, 2, 3, 5, 10, 20]

interface ConditionCardProps {
  cond: ScreenerCondition
  onChange: (patch: Partial<ScreenerCondition>) => void
  onRemove: () => void
}

/** 小号数字输入 */
function NumField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] text-[var(--text-muted)] whitespace-nowrap">
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v)
        }}
        className="w-16 px-1.5 py-1 text-xs font-num bg-[var(--bg-tertiary)] rounded border border-[var(--border)] text-[var(--text-primary)] focus:border-[var(--primary)] outline-none"
      />
    </label>
  )
}

const selectCls =
  "px-2 py-1 text-xs bg-[var(--bg-tertiary)] rounded border border-[var(--border)] text-[var(--text-primary)] focus:border-[var(--primary)] outline-none cursor-pointer"

/** 单个筛选条件卡片 */
export function ConditionCard({
  cond,
  onChange,
  onRemove,
}: ConditionCardProps): React.JSX.Element {
  const meta = COND_TYPE_META[cond.type]
  const showWindow = opUsesWindow(cond)
  const isThresholdOp = cond.op === "overbought" || cond.op === "oversold"
  const isMaArrange = cond.op === "bull_arrange" || cond.op === "bear_arrange"

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5 space-y-2">
      {/* 头部：指标名 + 摘要 + 删除 */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-primary)]">
          {meta.name}
        </span>
        <span className="text-[11px] text-[var(--text-muted)] truncate flex-1">
          {conditionSummary(cond)}
        </span>
        <button
          type="button"
          onClick={onRemove}
          title="删除条件"
          className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--bg-tertiary)] cursor-pointer shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 操作类型 */}
      <div className="flex items-center gap-2 flex-wrap">
        {cond.type === "pivot" ? (
          <select
            value={cond.side}
            onChange={(e) =>
              onChange({ side: e.target.value as ScreenerCondition["side"] })
            }
            className={selectCls}
          >
            {COND_TYPE_META.pivot.ops.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        ) : (
          <select
            value={cond.op}
            onChange={(e) => onChange({ op: e.target.value })}
            className={selectCls}
          >
            {meta.ops.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        )}

        {showWindow && (
          <label className="flex items-center gap-1.5">
            <span className="text-[11px] text-[var(--text-muted)]">出现于</span>
            <select
              value={cond.window}
              onChange={(e) => onChange({ window: Number(e.target.value) })}
              className={cn(selectCls, "w-auto")}
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  最近{w}根内
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* 各类型参数 */}
      <div className="flex items-center gap-3 flex-wrap">
        {cond.type === "pivot" && (
          <>
            <NumField label="左根数" value={cond.left} min={1} max={50} onChange={(v) => onChange({ left: v })} />
            <NumField label="右根数" value={cond.right} min={1} max={50} onChange={(v) => onChange({ right: v })} />
            <NumField label="ATR周期" value={cond.atr_period} min={1} max={100} onChange={(v) => onChange({ atr_period: v })} />
            <NumField
              label="最小幅度%"
              value={cond.min_amplitude_pct}
              min={0}
              max={50}
              step={0.5}
              onChange={(v) => onChange({ min_amplitude_pct: v })}
            />
            <NumField
              label="最小ATR倍数"
              value={cond.min_atr_mult}
              min={0}
              max={20}
              step={0.5}
              onChange={(v) => onChange({ min_atr_mult: v })}
            />
          </>
        )}

        {cond.type === "macd" && (
          <>
            <NumField label="快线" value={cond.fast} min={2} max={200} onChange={(v) => onChange({ fast: v })} />
            <NumField label="慢线" value={cond.slow} min={2} max={200} onChange={(v) => onChange({ slow: v })} />
            <NumField label="信号" value={cond.signal} min={2} max={200} onChange={(v) => onChange({ signal: v })} />
          </>
        )}

        {cond.type === "ma" && isMaArrange && (
          <>
            <NumField label="短周期" value={cond.ma_short} min={2} max={300} onChange={(v) => onChange({ ma_short: v })} />
            <NumField label="中周期" value={cond.ma_mid} min={2} max={300} onChange={(v) => onChange({ ma_mid: v })} />
            <NumField label="长周期" value={cond.ma_long} min={2} max={300} onChange={(v) => onChange({ ma_long: v })} />
          </>
        )}
        {cond.type === "ma" && !isMaArrange && (
          <NumField label="穿越均线" value={cond.cross_period} min={2} max={300} onChange={(v) => onChange({ cross_period: v })} />
        )}

        {cond.type === "kdj" && (
          <>
            <NumField label="RSV" value={cond.n} min={2} max={200} onChange={(v) => onChange({ n: v })} />
            <NumField label="K平滑" value={cond.k_smooth} min={1} max={100} onChange={(v) => onChange({ k_smooth: v })} />
            <NumField label="D平滑" value={cond.d_smooth} min={1} max={100} onChange={(v) => onChange({ d_smooth: v })} />
            {isThresholdOp && cond.overbought != null && (
              <NumField label="超买" value={cond.overbought} min={50} max={100} onChange={(v) => onChange({ overbought: v })} />
            )}
            {isThresholdOp && cond.oversold != null && (
              <NumField label="超卖" value={cond.oversold} min={0} max={50} onChange={(v) => onChange({ oversold: v })} />
            )}
          </>
        )}

        {cond.type === "rsi" && (
          <>
            <NumField label="周期" value={cond.period} min={2} max={200} onChange={(v) => onChange({ period: v })} />
            {isThresholdOp && cond.overbought != null && (
              <NumField label="超买" value={cond.overbought} min={50} max={100} onChange={(v) => onChange({ overbought: v })} />
            )}
            {isThresholdOp && cond.oversold != null && (
              <NumField label="超卖" value={cond.oversold} min={0} max={50} onChange={(v) => onChange({ oversold: v })} />
            )}
          </>
        )}

        {cond.type === "boll" && (
          <>
            <NumField label="周期" value={cond.period} min={2} max={200} onChange={(v) => onChange({ period: v })} />
            <NumField label="标准差倍数" value={cond.std} min={0.5} max={5} step={0.1} onChange={(v) => onChange({ std: v })} />
          </>
        )}
      </div>

      {cond.type === "pivot" && (
        <p className="text-[10px] text-[var(--text-muted)]">
          参数默认取自你的图表「波段」指标设置；K线图需启用波段指标，
          且此处参数与图表一致时，图上「多/空」标注才与筛选结果对应
        </p>
      )}
    </div>
  )
}
