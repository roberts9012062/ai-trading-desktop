"use client"

/**
 * 强弱形态 V2 参数表单（回测 / AI 参考策略共用）
 *
 * 语义：六档信号双向——多侧（底部衰竭/反弹确认/多头中继）开多，空侧
 * （顶部衰竭/破位确认/空头中继）开空；反向信号或 regime 翻转平仓。
 * 参数与图表 V2 副图同口径（方案一重定义后），见 lib/strength-v2.ts
 * 与后端 signal_strength_v2.py。
 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QuantParamsState } from "@/lib/quant-strategy"

interface StrengthV2ParamsProps {
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

export function StrengthEntryV2Params({
  quant,
  onQuant,
}: StrengthV2ParamsProps): React.JSX.Element {
  const set = (patch: Partial<QuantParamsState>) => onQuant({ ...quant, ...patch })
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <NumField label="归一化窗口" value={quant.sv2Period} min={2}
          onChange={(v) => set({ sv2Period: v })} />
        <NumField label="滞回带半宽" value={quant.sv2Band} min={1} max={25}
          onChange={(v) => set({ sv2Band: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField label="一次平滑" value={quant.sv2Smooth} min={1}
          onChange={(v) => set({ sv2Smooth: v })} />
        <NumField label="二次平滑" value={quant.sv2Smooth2} min={1}
          onChange={(v) => set({ sv2Smooth2: v })} />
        <NumField label="冷却（根）" value={quant.sv2Cooldown} min={0}
          onChange={(v) => set({ sv2Cooldown: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField label="衰竭窗口" value={quant.sv2ExhaustWin} min={2} max={20}
          onChange={(v) => set({ sv2ExhaustWin: v })} />
        <NumField label="收缩比上限" value={quant.sv2ShrinkRatio} min={0.1} max={1} step={0.05}
          onChange={(v) => set({ sv2ShrinkRatio: v })} />
        <NumField label="走平上限" value={quant.sv2FlatEps} min={0.1} max={20} step={0.1}
          onChange={(v) => set({ sv2FlatEps: v })} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField label="段内容差" value={quant.sv2ZoneDrop} min={1} max={50}
          onChange={(v) => set({ sv2ZoneDrop: v })} />
        <NumField label="ATR 缓冲" value={quant.sv2BufMult} min={0} max={5} step={0.1}
          onChange={(v) => set({ sv2BufMult: v })} />
        <NumField label="ATR 周期" value={quant.sv2AtrPeriod} min={2}
          onChange={(v) => set({ sv2AtrPeriod: v })} />
      </div>

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        六档双向：<b>底部/顶部衰竭</b>=段谷/峰附近动能枯竭（预警）；<b>反弹/破位</b>=
        regime 翻转确认；<b>中继</b>=回调不创新低（ATR 缓冲）再顺势。反向信号
        或 regime 翻转即平仓；冷却同时是信号新鲜度窗口。默认 14/3/2 与图表
        V2 副图同口径，可在图上先看形态再回填。
      </p>
    </div>
  )
}
