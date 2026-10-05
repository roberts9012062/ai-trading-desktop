import type { QuantKind } from "./quant-strategy"
import { iconSrc, isValidIconSlug } from "./ai-icons-manifest"

/** Shared by strategy selection, automatic task avatars and the icon picker. */
export const QUANT_STRATEGY_ICONS: Record<QuantKind, { color: string; detail: string }> = {
  n_breakout: { color: "#38bdf8", detail: "区间突破" },
  ma_cross: { color: "#2dd4bf", detail: "趋势交叉" },
  macd_cross: { color: "#9aa9ff", detail: "动量交叉" },
  kdj_cross: { color: "#c4a2ff", detail: "随机指标" },
  band_swing: { color: "#fbbf24", detail: "波动区间" },
  swing_pivot: { color: "#fb7185", detail: "价格转折" },
  swing_pivot_v2: { color: "#fb923c", detail: "量价转折" },
  swing_pro: { color: "#f8d483", detail: "双周期共振" },
  strength_entry: { color: "#a3e635", detail: "强弱进场" },
  strength_entry_v2: { color: "#5eead4", detail: "双向形态" },
  factor: { color: "#7dd3fc", detail: "公式信号" },
  shortline_factor: { color: "#f6a976", detail: "高频节奏" },
}

export function strategyIconSrc(strategyType?: string | null): string | null {
  const kind = String(strategyType ?? "").toLowerCase()
  return Object.hasOwn(QUANT_STRATEGY_ICONS, kind) ? `/strategy-icons/${kind}.svg` : null
}

export function resolveTaskIconSrc(icon?: string | null, strategyType?: string | null, providerSrc?: string | null): string | null {
  const strategy = strategyIconSrc(strategyType)
  // The server supplies these generic defaults even when a task's saved icon is null.
  if (strategy && (icon === "quant" || (icon === "factor" && strategyType?.toLowerCase() === "factor"))) return strategy
  if (isValidIconSlug(icon)) return iconSrc(icon!)
  if (strategy) return strategy
  return providerSrc && !providerSrc.endsWith("/default.svg") ? providerSrc : null
}
