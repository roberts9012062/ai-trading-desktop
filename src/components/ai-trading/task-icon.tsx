"use client"

/**
 * 任务头像图标
 * 优先级：task.icon(slug) → 厂商匹配 → 策略默认(quant/factor) → 「AI」字样
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import {
  iconSrc,
  isValidIconSlug,
} from "@/lib/ai-icons-manifest"
import { resolveProviderAvatar } from "@/lib/provider-avatar"

interface TaskIconProps {
  /** 显式图标 slug；空=自动 */
  icon?: string | null
  modelId?: string | null
  providerName?: string | null
  displayName?: string | null
  strategyType?: string | null
  size?: number
  className?: string
}

/** 量化策略类型集合（这些 strategyType 默认用 quant 图标） */
const QUANT_STRATS = new Set([
  "ma_cross",
  "n_breakout",
  "macd_cross",
  "kdj_cross",
  "band_swing",
  "swing_pivot",
])

/** 解析最终图源：有值=用图；null=用文字 */
function resolveSrc(
  icon: string | null | undefined,
  strategyType: string | null | undefined,
  info: { src: string | null },
): string | null {
  if (icon && isValidIconSlug(icon)) return iconSrc(icon)
  if (info.src && !info.src.endsWith("/default.svg")) return info.src
  const st = String(strategyType || "").toLowerCase()
  if (st === "factor") return iconSrc("factor")
  if (QUANT_STRATS.has(st)) return iconSrc("quant")
  return null
}

/** 任务头像 */
export function TaskIcon({
  icon,
  modelId,
  providerName,
  displayName,
  strategyType,
  size = 26,
  className,
}: TaskIconProps): React.JSX.Element {
  const info = resolveProviderAvatar(modelId, providerName, displayName)
  const resolved = resolveSrc(icon, strategyType, info)
  const [failed, setFailed] = useState(false)
  const showImg = Boolean(resolved) && !failed
  const stype = String(strategyType || "").toLowerCase()
  const fallbackLabel =
    stype === "factor" ? "因" : QUANT_STRATS.has(stype) ? "量" : "AI"

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full shrink-0 overflow-hidden text-[10px] font-semibold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: showImg ? "var(--bg-tertiary)" : info.bg,
        fontSize: Math.max(9, Math.floor(size * 0.4)),
      }}
      title={displayName || providerName || info.shortName || "AI"}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolved ?? ""}
          alt={info.shortName || "icon"}
          width={size}
          height={size}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        fallbackLabel
      )}
    </span>
  )
}
