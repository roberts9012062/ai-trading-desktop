/**
 * AI 看盘主播 store 持久化助手与常量
 *
 * 草稿/语音开关/音色/语速的 localStorage 读写(异常静默回默认),
 * 以及指标参数 schema 的前端兜底常量(后端 /indicators 为准)。
 */

import type {
  AnchorDirectionMode,
  AnchorHorizon,
  AnchorIndicatorItem,
  AnchorParamSpec,
} from "@/lib/ai-anchor-api"
import { ANCHOR_TIMEFRAMES, MAX_TIMEFRAMES } from "@/lib/ai-anchor-api"
import { setAnchorVoiceSettings } from "@/lib/speech"

export const DRAFT_KEY = "qihuo-ai-anchor-draft"
export const VOICE_KEY = "qihuo-ai-anchor-voice"
export const VOICE_URI_KEY = "qihuo-ai-anchor-voice-uri"
export const VOICE_RATE_KEY = "qihuo-ai-anchor-voice-rate"

/** 配置草稿 */
export interface AnchorDraft {
  modelRowId: string
  symbol: string
  timeframes: string[]
  directionMode: AnchorDirectionMode
  barCount: number
  intervalMinutes: number
  indicators: AnchorIndicatorItem[]
  horizon: AnchorHorizon
}

export const DEFAULT_DRAFT: AnchorDraft = {
  modelRowId: "",
  symbol: "",
  timeframes: ["15m"],
  directionMode: "any",
  barCount: 60,
  intervalMinutes: 15,
  indicators: [{ name: "MA", params: { period: 20 } }],
  horizon: "short",
}

/** 归一分时段列表：白名单过滤 + 保序去重 + 上限（空回退默认） */
export function normalizeTimeframes(items: unknown): string[] {
  const raw = Array.isArray(items) ? items : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tf of raw) {
    const value = String(tf)
    if ((ANCHOR_TIMEFRAMES as readonly string[]).includes(value) && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out.slice(0, MAX_TIMEFRAMES)
}

/** 前端兜底的参数 schema（后端 /indicators 为准，拉取失败时用） */
export const FALLBACK_INDICATOR_SCHEMA: Record<string, AnchorParamSpec[]> = {
  MA: [{ key: "period", label: "周期", default: 20, min: 2, max: 200, step: 1 }],
  EMA: [{ key: "period", label: "周期", default: 20, min: 2, max: 200, step: 1 }],
  BOLL: [
    { key: "period", label: "周期", default: 20, min: 2, max: 200, step: 1 },
    { key: "std", label: "标准差倍数", default: 2.0, min: 0.5, max: 5.0, step: 0.1 },
  ],
  MACD: [
    { key: "fast", label: "快线", default: 12, min: 2, max: 200, step: 1 },
    { key: "slow", label: "慢线", default: 26, min: 2, max: 200, step: 1 },
    { key: "signal", label: "信号线", default: 9, min: 2, max: 200, step: 1 },
  ],
  RSI: [
    { key: "period", label: "周期", default: 14, min: 2, max: 200, step: 1 },
    { key: "overbought", label: "超买阈值", default: 70, min: 50, max: 100, step: 1 },
    { key: "oversold", label: "超卖阈值", default: 30, min: 0, max: 50, step: 1 },
  ],
  KDJ: [
    { key: "n", label: "RSV周期", default: 9, min: 2, max: 200, step: 1 },
    { key: "k", label: "K平滑", default: 3, min: 1, max: 50, step: 1 },
    { key: "d", label: "D平滑", default: 3, min: 1, max: 50, step: 1 },
  ],
  PIVOT: [
    { key: "left", label: "左侧确认根数", default: 3, min: 2, max: 20, step: 1 },
    { key: "right", label: "右侧确认根数", default: 3, min: 2, max: 20, step: 1 },
    { key: "min_amplitude_pct", label: "最小幅度%", default: 1.5, min: 0, max: 50, step: 0.1 },
    { key: "min_atr_mult", label: "ATR倍数门槛", default: 1.5, min: 0, max: 20, step: 0.1 },
    { key: "atr_period", label: "ATR周期", default: 14, min: 2, max: 200, step: 1 },
    { key: "min_right_live", label: "盘中预确认根数", default: 1, min: 1, max: 20, step: 1 },
  ],
}

/** 从 localStorage 恢复草稿（异常/缺失回默认；旧版单 timeframe 自动迁移为数组） */
export function loadDraft(): AnchorDraft {
  if (typeof window === "undefined") return DEFAULT_DRAFT
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return DEFAULT_DRAFT
    const parsed = JSON.parse(raw) as Partial<AnchorDraft> & { timeframe?: string }
    const directionMode: AnchorDirectionMode =
      parsed.directionMode === "long" || parsed.directionMode === "short"
        ? parsed.directionMode
        : "any"
    const horizon: AnchorHorizon =
      parsed.horizon === "mid" || parsed.horizon === "long" ? parsed.horizon : "short"
    const timeframes = normalizeTimeframes(
      parsed.timeframes ?? (parsed.timeframe ? [parsed.timeframe] : undefined),
    )
    return {
      modelRowId: typeof parsed.modelRowId === "string" ? parsed.modelRowId : "",
      symbol: typeof parsed.symbol === "string" ? parsed.symbol : "",
      timeframes: timeframes.length > 0 ? timeframes : DEFAULT_DRAFT.timeframes,
      directionMode,
      barCount:
        typeof parsed.barCount === "number" ? Math.min(100, Math.max(30, parsed.barCount)) : 60,
      intervalMinutes:
        typeof parsed.intervalMinutes === "number"
          ? Math.min(30, Math.max(5, parsed.intervalMinutes))
          : 15,
      indicators: Array.isArray(parsed.indicators) ? parsed.indicators : DEFAULT_DRAFT.indicators,
      horizon,
    }
  } catch {
    return DEFAULT_DRAFT
  }
}

/** 持久化草稿（写失败静默） */
export function saveDraft(draft: AnchorDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // 隐私模式写失败忽略
  }
}

/** 语音开关持久化（默认开） */
export function loadVoiceEnabled(): boolean {
  if (typeof window === "undefined") return true
  return localStorage.getItem(VOICE_KEY) !== "0"
}

export function saveVoiceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(VOICE_KEY, enabled ? "1" : "0")
  } catch {
    // 忽略
  }
}

/** 音色 voiceURI 持久化（null=自动选中文语音） */
export function loadVoiceURI(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(VOICE_URI_KEY)
}

export function saveVoiceURI(voiceURI: string | null): void {
  try {
    if (voiceURI) {
      localStorage.setItem(VOICE_URI_KEY, voiceURI)
    } else {
      localStorage.removeItem(VOICE_URI_KEY)
    }
  } catch {
    // 忽略
  }
}

/** 语速持久化（0.5-1.5，默认 1） */
export function loadVoiceRate(): number {
  if (typeof window === "undefined") return 1
  const raw = Number(localStorage.getItem(VOICE_RATE_KEY))
  if (!Number.isFinite(raw) || raw < 0.5 || raw > 1.5) return 1
  return raw
}

export function saveVoiceRate(rate: number): void {
  try {
    localStorage.setItem(VOICE_RATE_KEY, String(rate))
  } catch {
    // 忽略
  }
}

/** 把音色/语速注入 speech 模块（store 初始化与变更时调用） */
export function applyVoiceSettings(voiceURI: string | null, rate: number): void {
  setAnchorVoiceSettings({ voiceURI, rate })
}
