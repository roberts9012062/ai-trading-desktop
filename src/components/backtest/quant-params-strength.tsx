"use client"

/**
 * 强弱进场参数表单（回测 / AI 参考策略共用）
 *
 * 语义：0–100 强弱指标三档进场信号做多（超跌>反弹>波段，内核含同档冷却），
 * 强弱收盘值跌破退出阈值平多；不出空信号。算法与图表副图同口径，
 * 见 lib/strength-index.ts 与后端 signal_strength.py。
 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QuantParamsState } from "@/lib/quant-strategy"

interface StrengthParamsProps {
  quant: QuantParamsState
  onQuant: (next: QuantParamsState) => void
}

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
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function StrengthEntryParams({
  quant,
  onQuant,
}: StrengthParamsProps): React.JSX.Element {
  const set = (patch: Partial<QuantParamsState>) => onQuant({ ...quant, ...patch })
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <NumField label="归一化窗口" value={quant.strengthPeriod} min={2}
          onChange={(v) => set({ strengthPeriod: v })} />
        <NumField label="趋势均线周期" value={quant.strengthTrendMa} min={2}
          onChange={(v) => set({ strengthTrendMa: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField label="一次平滑" value={quant.strengthSmooth} min={1}
          onChange={(v) => set({ strengthSmooth: v })} />
        <NumField label="二次平滑" value={quant.strengthSmooth2} min={1}
          onChange={(v) => set({ strengthSmooth2: v })} />
        <NumField label="冷却（根）" value={quant.strengthCooldown} min={0}
          onChange={(v) => set({ strengthCooldown: v })} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumField label="波段阈值" value={quant.strengthSwingTh} min={0} max={100} step={1}
          onChange={(v) => set({ strengthSwingTh: v })} />
        <NumField label="反弹阈值" value={quant.strengthReboundTh} min={0} max={100} step={1}
          onChange={(v) => set({ strengthReboundTh: v })} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumField label="弱区线" value={quant.strengthOversold} min={0} step={1}
          onChange={(v) => set({ strengthOversold: v })} />
        <NumField label="反弹回溯（根）" value={quant.strengthLookback} min={1}
          onChange={(v) => set({ strengthLookback: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField label="极低位线" value={quant.strengthDeepLevel} min={0} step={1}
          onChange={(v) => set({ strengthDeepLevel: v })} />
        <NumField label="钝化（根）" value={quant.strengthDeepBars} min={1}
          onChange={(v) => set({ strengthDeepBars: v })} />
        <NumField label="平多阈值" value={quant.strengthExit} min={0} step={1}
          onChange={(v) => set({ strengthExit: v })} />
      </div>

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        三档进场（只做多）：<b>波段</b>=上穿阈值且价在均线上；<b>反弹</b>=近期到过
        弱区后回升上穿；<b>超跌</b>=极低位钝化后首次拐头。强弱收盘值跌破
        <b>平多阈值</b>离场；冷却同时是信号新鲜度窗口。参数与图表「强弱」
        副图同口径，可在图上先看形态再回填。
      </p>
    </div>
  )
}
