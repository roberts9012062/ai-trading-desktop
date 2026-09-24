/**
 * 按模型 ID / 渠道名解析厂商头像与主题色
 * 规则数据见 provider-brand-rules.ts；未命中则用名字生成色相 + 缩写（空→"AI"）
 */

import { BRAND_RULES } from "@/lib/provider-brand-rules"

export interface ProviderAvatarInfo {
  /** public 路径，如 /ai-icons/openai.png；无素材时为 null */
  src: string | null
  /** 品牌/回退背景色（徽章描边与点缀） */
  bg: string
  /** 曲线推荐色 */
  line: string
  /** 1~2 字缩写 */
  initials: string
  /** 厂商 key */
  brand: string
  /** 展示用短名 */
  shortName: string
}

/** 简单字符串 hash → 色相 */
function hashHue(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0
  }
  return h % 360
}

function makeInitials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9一-龥]/g, " ").trim()
  if (!clean) return "AI"
  if (/[一-龥]/.test(clean)) {
    return clean.replace(/\s+/g, "").slice(0, 2)
  }
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}

/** 解析模型头像信息（按 model_id / provider / display_name 匹配厂商） */
export function resolveProviderAvatar(
  modelId: string | null | undefined,
  providerName: string | null | undefined,
  displayName: string | null | undefined,
): ProviderAvatarInfo {
  const hay = `${modelId ?? ""} ${providerName ?? ""} ${displayName ?? ""}`
  for (const rule of BRAND_RULES) {
    if (rule.test.test(hay)) {
      return {
        src: rule.src,
        bg: rule.bg,
        line: rule.line,
        initials: makeInitials(displayName || providerName || rule.shortName),
        brand: rule.brand,
        shortName: rule.shortName,
      }
    }
  }
  const label = displayName || providerName || modelId || "AI"
  const hue = hashHue(label)
  const bg = `hsl(${hue} 55% 42%)`
  return {
    src: null,
    bg,
    line: bg,
    initials: makeInitials(label),
    brand: "default",
    shortName: label.slice(0, 12),
  }
}

/** 稳定色：同一模型始终同色（按 brand + 名字） */
export function resolveSeriesColor(
  modelId: string | null | undefined,
  providerName: string | null | undefined,
  displayName: string | null | undefined,
  fallbackIndex: number,
): string {
  const info = resolveProviderAvatar(modelId, providerName, displayName)
  if (info.brand !== "default") return info.line
  const palette = [
    "#3b82f6",
    "#22c55e",
    "#f59e0b",
    "#a855f7",
    "#ef4444",
    "#06b6d4",
    "#ec4899",
    "#84cc16",
  ]
  return palette[fallbackIndex % palette.length]
}
