"use client"

import { cn } from "@/lib/utils"

/**
 * 轻量开关 —— 与 alert-settings-panel 的 ToggleRow 同款样式
 *
 * 项目暂未引入 @radix-ui/react-switch，统一用此自研实现保持一致。
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        "w-8 h-4 rounded-full transition-colors relative shrink-0",
        checked ? "bg-[var(--primary)]" : "bg-[var(--bg-tertiary)]",
        disabled && "opacity-50 cursor-not-allowed",
        !disabled && "cursor-pointer",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  )
}
