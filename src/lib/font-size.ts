/** 全局界面字号 —— 照顾年长投资者，localStorage 持久化 */

export type FontSizeLevel = "standard" | "large" | "xlarge" | "xxlarge"

export const FONT_SIZE_STORAGE_KEY = "atd_font_size"

export interface FontSizeOption {
  value: FontSizeLevel
  label: string
  /** 相对标准字号的说明 */
  description: string
  /** 预览用字号 class 参考 */
  previewClass: string
  /** html 根字号（px） */
  rootPx: number
}

/** 可选档位：标准 → 特大 */
export const FONT_SIZE_OPTIONS: FontSizeOption[] = [
  {
    value: "standard",
    label: "标准",
    description: "默认字号，信息密度较高",
    previewClass: "text-sm",
    rootPx: 16,
  },
  {
    value: "large",
    label: "较大",
    description: "略放大，日常浏览更轻松",
    previewClass: "text-base",
    rootPx: 18,
  },
  {
    value: "xlarge",
    label: "大",
    description: "适合长时间盯盘、视力一般",
    previewClass: "text-lg",
    rootPx: 20,
  },
  {
    value: "xxlarge",
    label: "特大",
    description: "最大档，适合年长投资者",
    previewClass: "text-xl",
    rootPx: 22,
  },
]

const VALID = new Set<FontSizeLevel>(
  FONT_SIZE_OPTIONS.map((o) => o.value),
)

/** 规范化字号档位 */
export function normalizeFontSize(value: string | null | undefined): FontSizeLevel {
  if (value && VALID.has(value as FontSizeLevel)) {
    return value as FontSizeLevel
  }
  return "standard"
}

/** 从 localStorage 读取（仅浏览器） */
export function readStoredFontSize(): FontSizeLevel {
  if (typeof window === "undefined") {
    return "standard"
  }
  try {
    return normalizeFontSize(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY))
  } catch {
    return "standard"
  }
}

/** 写入 localStorage 并应用到 <html data-font-size> */
export function applyFontSize(level: FontSizeLevel): void {
  const next = normalizeFontSize(level)
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-font-size", next)
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, next)
    } catch {
      // 隐私模式等写失败时仍保持本次 DOM 生效
    }
  }
}

/** 获取档位展示信息 */
export function getFontSizeOption(level: FontSizeLevel): FontSizeOption {
  return (
    FONT_SIZE_OPTIONS.find((o) => o.value === level) ?? FONT_SIZE_OPTIONS[0]
  )
}
