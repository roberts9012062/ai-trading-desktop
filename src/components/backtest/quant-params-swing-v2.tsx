"use client"

/**
 * 枢轴波段 V2 参数表单（回测 / AI 参考策略共用）
 *
 * 语义：前期高点处放量上影拒绝 / 缩量多K上攻失败 → 做空；前期低点镜像 →
 * 做多；参考位被突破 = 假信号（不再依其开仓）。算法见 lib/pivot-signals-v2.ts
 * 与后端 signal_pivot_v2.py。
 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QuantParamsState } from "@/lib/quant-strategy"

interface SwingV2ParamsProps {
  quant: QuantParamsState
  onQuant: (next: QuantParamsState) => void
}

function NumField({
  label,
  value,
  min,
  step,
  onChange,
}: {
  label: string
  value: number
  min?: number
  step?: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function SwingV2Params({
  quant,
  onQuant,
}: SwingV2ParamsProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <NumField
          label="前期高低点·左确认根数"
          value={quant.swingLeft}
          min={1}
          onChange={(v) => onQuant({ ...quant, swingLeft: v })}
        />
        <NumField
          label="前期高低点·右确认根数"
          value={quant.swingRight}
          min={2}
          onChange={(v) => onQuant({ ...quant, swingRight: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumField
          label="冲击到位容差（×ATR）"
          value={quant.swingProximity}
          min={0}
          step={0.1}
          onChange={(v) => onQuant({ ...quant, swingProximity: v })}
        />
        <NumField
          label="上攻失败深度（×ATR）"
          value={quant.swingWickMult}
          min={0}
          step={0.1}
          onChange={(v) => onQuant({ ...quant, swingWickMult: v })}
        />
        <NumField
          label="多K上攻窗口（根）"
          value={quant.swingAttackWindow}
          min={1}
          onChange={(v) => onQuant({ ...quant, swingAttackWindow: v })}
        />
        <NumField
          label="同侧信号间隔（根）"
          value={quant.swingCooldown}
          min={0}
          onChange={(v) => onQuant({ ...quant, swingCooldown: v })}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField
          label="量能急放下限（×均量）"
          value={quant.swingVolExpand}
          min={0}
          step={0.1}
          onChange={(v) => onQuant({ ...quant, swingVolExpand: v })}
        />
        <NumField
          label="量能急缩上限（×均量）"
          value={quant.swingVolShrink}
          min={0}
          step={0.1}
          onChange={(v) => onQuant({ ...quant, swingVolShrink: v })}
        />
        <NumField
          label="均量窗口"
          value={quant.swingVolMaPeriod}
          min={2}
          onChange={(v) => onQuant({ ...quant, swingVolMaPeriod: v })}
        />
      </div>

      <NumField
        label="ATR 周期"
        value={quant.swingAtrPeriod}
        min={1}
        onChange={(v) => onQuant({ ...quant, swingAtrPeriod: v })}
      />

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        与 V1 的差异：V1 等右侧确认后反转；V2 在<b>前期高点/低点</b>处出现
        <b>放量影线拒绝</b>（急速放量 = 吸收）或<b>缩量多K上攻失败</b>（急速
        萎缩 = 衰竭）即刻进场，参考位被突破视为假信号不再依其开仓。
      </p>
      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        调参要点：<b>失败深度</b>调大 → 只认惨烈的拒绝；调小 → 轻微回落也算。
        <b>容差</b>调大 → 距参考位较远的冲击也触发。量能两条阈值之间的
        "常态量"不触发；各数据源成交量口径不同，换品种后先看信号密度再微调。
        完整讲解见 docs/pivot-v2-guide.md。
      </p>
    </div>
  )
}
