"use client"

/**
 * 任务头像图标
 * 自选头像优先；量化任务按策略自动区分，AI 任务按模型厂商匹配。
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import { resolveProviderAvatar } from "@/lib/provider-avatar"
import { QUANT_STRATEGY_ICONS, resolveTaskIconSrc } from "@/lib/quant-strategy-icons"

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
  const resolved = resolveTaskIconSrc(icon, strategyType, info.src)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImg = Boolean(resolved) && resolved !== failedSrc
  const stype = String(strategyType || "").toLowerCase()
  const fallbackLabel =
    stype === "factor" ? "因" : Object.hasOwn(QUANT_STRATEGY_ICONS, stype) ? "量" : "AI"

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0 overflow-hidden text-[10px] font-semibold text-white",
        resolved?.startsWith("/strategy-icons/") ? "rounded-[26%]" : "rounded-full",
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
          alt={displayName || strategyType || info.shortName || "任务图标"}
          width={size}
          height={size}
          className="w-full h-full object-cover"
          onError={() => setFailedSrc(resolved)}
        />
      ) : (
        fallbackLabel
      )}
    </span>
  )
}
