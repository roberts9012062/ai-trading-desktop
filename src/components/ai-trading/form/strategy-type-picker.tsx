import type { CSSProperties } from "react"
import { Check } from "lucide-react"
import { QUANT_KIND_OPTIONS, type QuantKind } from "@/lib/quant-strategy"
import { QUANT_STRATEGY_ICONS, strategyIconSrc } from "@/lib/quant-strategy-icons"
import { cn } from "@/lib/utils"

export function StrategyTypePicker({ value, onChange }: { value: QuantKind; onChange: (value: QuantKind) => void }) {
  return <div role="group" aria-label="策略类型" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
    {QUANT_KIND_OPTIONS.map(option => {
      const active = value === option.value
      const design = QUANT_STRATEGY_ICONS[option.value]
      return <button
        key={option.value}
        type="button"
        aria-label={option.label}
        aria-pressed={active}
        disabled={option.disabled === true}
        title={option.disabled ? "该策略暂停使用" : undefined}
        className={cn("strategy-choice", active && "strategy-choice-active")}
        style={{ "--strategy-color": design.color } as CSSProperties}
        onClick={() => onChange(option.value)}
      >
        <img src={strategyIconSrc(option.value)!} alt="" width={32} height={32} className="shrink-0 rounded-[9px]" />
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-[11px] font-medium leading-[1.4]">{option.label}</span>
          <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">{design.detail}</span>
        </span>
        {active && <Check size={12} className="strategy-choice-check" aria-hidden="true" />}
      </button>
    })}
  </div>
}
