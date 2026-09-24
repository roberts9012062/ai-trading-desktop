"use client"

/**
 * 语音播报引擎 —— 全局常驻（由 (main)/layout 挂载启动）
 *
 * 调度：1s 心跳 + 整分墙钟对齐桶（voice-broadcast-core.collectDue）。
 * 多品种同刻到点 → 按配置顺序入队，逐条播报、间隔 1 秒（QUEUE_GAP_MS）。
 * 声音：云端自然音色优先（后端 edge-tts 代理微软神经音色：云希/晓晓/
 * 晓伊等，任何浏览器可用），失败回退本地 Web Speech（机械声兜底）。
 * 行情直接读 market store（WS 实时），缺数时拉一次 HTTP 快照兜底；
 * 品种→当前主力合约读 market store 的合约树（layout 启动即拉取）。
 */

import { useMarketStore } from "@/stores/market"
import { useVoiceBroadcastStore } from "@/stores/voice-broadcast"
import { getQuotesSnapshotApi } from "@/lib/api"
import { synthesizeAnchorTtsApi } from "@/lib/ai-anchor-api"
import {
  QUEUE_GAP_MS,
  clampRate,
  buildBroadcastText,
  collectDue,
  enqueueDedup,
  isQuoteFresh,
} from "@/lib/voice-broadcast-core.mjs"

interface QueueEntry {
  code: string
  text: string
}

export type TestSpeakResult = "ok" | "no-voice" | "no-data"
type ClipResult = "cloud" | "local" | "none"

const TICK_MS = 1000
/** 自动模式默认云端音色：云希（与主播 speech.ts 默认一致） */
const DEFAULT_CLOUD_VOICE = "zh-CN-YunxiNeural"
/** 单条播报播放兜底超时（云端合成约 1~3s + 播放数秒） */
const CLIP_TIMEOUT_MS = 30_000
/** 后端 edge-tts 语速范围（超出部分在调用侧收敛） */
const CLOUD_RATE_MAX = 1.5

let _started = false
let _ticker: ReturnType<typeof setInterval> | null = null
const _lastBuckets = new Map<string, number>()
let _queue: QueueEntry[] = []
let _speaking = false
let _snapshotQuotes: Record<string, Record<string, unknown>> = {}
let _snapshotFetching: Promise<void> | null = null
let _cloudDownUntil = 0

/** 播放单个 mp3 blob；resolve(true)=自然播完 */
function playCloudBlob(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    let url = ""
    const timer = setTimeout(() => finish(false), CLIP_TIMEOUT_MS)
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (url) {
        try {
          URL.revokeObjectURL(url)
        } catch {
          // 忽略
        }
      }
      resolve(ok)
    }
    try {
      url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => finish(true)
      audio.onerror = () => finish(false)
      void audio.play().catch(() => finish(false))
    } catch {
      finish(false)
    }
  })
}

/** 本地 Web Speech 单条朗读；resolve(false)=环境不可用 */
function speakLocalOnce(text: string, rate: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve(false)
      return
    }
    let done = false
    const timer = setTimeout(
      () => finish(false),
      Math.min(30_000, text.length * 400 + 3000),
    )
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok)
    }
    try {
      const utter = new SpeechSynthesisUtterance(text)
      utter.lang = "zh-CN"
      utter.rate = clampRate(rate)
      utter.volume = 1
      const voices = window.speechSynthesis.getVoices()
      const zh = voices.find((v) => (v.lang || "").toLowerCase().startsWith("zh"))
      if (zh) utter.voice = zh
      utter.onend = () => finish(true)
      utter.onerror = () => finish(false)
      window.speechSynthesis.speak(utter)
    } catch {
      finish(false)
    }
  })
}

/**
 * 播一条：云端自然音色优先（连续失败熔断 60s 直走本地），本地兜底。
 * 播报文本短（~30 字），单次合成即可，无需主播那套长文分段。
 */
async function playClip(text: string): Promise<ClipResult> {
  const { voiceId = "", rate = 1 } = useVoiceBroadcastStore.getState().settings
  if (voiceId !== "local" && Date.now() >= _cloudDownUntil) {
    const v = voiceId || DEFAULT_CLOUD_VOICE
    try {
      const r = Math.min(CLOUD_RATE_MAX, clampRate(rate))
      const blob = await synthesizeAnchorTtsApi(text, v, r)
      if (blob && blob.size > 0 && (await playCloudBlob(blob))) {
        return "cloud"
      }
    } catch {
      // 云端不可用：熔断一分钟，后续条目直接走本地（少一次网络等待）
      _cloudDownUntil = Date.now() + 60_000
    }
  }
  const ok = await speakLocalOnce(text, rate)
  return ok ? "local" : "none"
}

function pump(): void {
  if (_speaking) return
  const next = _queue.shift()
  if (!next) return
  _speaking = true
  void playClip(next.text).then(() => {
    // 间隔 1 秒再播下一条（需求：同时到点排队播报，间隔 1 秒）
    setTimeout(() => {
      _speaking = false
      pump()
    }, QUEUE_GAP_MS)
  })
}

/** 品种 → 当前主力合约（market store 合约树） */
function masterOf(code: string): string {
  const tree = useMarketStore.getState().codeTree as
    | Record<string, { master?: unknown }>
    | null
  const m = tree?.[code]?.master
  return m ? String(m).trim().toLowerCase() : ""
}

/** 合约树缺失时补拉（带超时保护） */
async function ensureTree(timeoutMs: number): Promise<void> {
  const fetch = useMarketStore.getState().fetchCodeTree
  if (!fetch) return
  try {
    await Promise.race([
      fetch(),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ])
  } catch {
    // 拉取失败：本轮跳过
  }
}

function resolveQuote(symbol: string): Record<string, unknown> | null {
  const q = useMarketStore.getState().quotes[symbol]
  if (q && Number(q.last_price) > 0) return q as unknown as Record<string, unknown>
  const snap = _snapshotQuotes[symbol]
  if (snap && Number(snap.last_price) > 0) return snap
  return null
}

/** 快照兜底：WS 未就绪/首屏时拉一次全量快照（并发共享单飞） */
function ensureSnapshot(): Promise<void> {
  if (_snapshotFetching) return _snapshotFetching
  _snapshotFetching = (async () => {
    try {
      const raw = await getQuotesSnapshotApi()
      const quotes: Record<string, Record<string, unknown>> = {}
      for (const item of Array.isArray(raw) ? raw : []) {
        const symbol = String(item?.symbol ?? "").trim().toLowerCase()
        const last = Number(item?.last_price)
        if (symbol && Number.isFinite(last) && last > 0) quotes[symbol] = item
      }
      if (Object.keys(quotes).length > 0) _snapshotQuotes = quotes
    } catch {
      // 快照失败：本轮跳过
    } finally {
      _snapshotFetching = null
    }
  })()
  return _snapshotFetching
}

function onTick(): void {
  const { settings } = useVoiceBroadcastStore.getState()
  if (!settings.enabled) {
    // 总开关关闭：清桶，重开时从新周期起步
    _lastBuckets.clear()
    return
  }
  const due = collectDue(settings.items, Date.now(), _lastBuckets)
  if (due.length === 0) return
  const entries: QueueEntry[] = []
  let missingData = false
  const now = Date.now()
  for (const item of due) {
    const symbol = masterOf(item.code)
    if (!symbol) {
      missingData = true
      continue
    }
    const quote = resolveQuote(symbol)
    if (!quote) {
      missingData = true
      continue
    }
    // 停盘门控：最新 tick 超时即停盘/休市/断流，跳过定时播报
    // （试听不设此门控，方便任意时段验证音色）
    if (!isQuoteFresh(quote, now)) continue
    const text = buildBroadcastText(item.name, quote)
    if (text) entries.push({ code: item.code, text })
  }
  if (missingData) {
    void ensureTree(3000)
    void ensureSnapshot()
  }
  if (entries.length === 0) return
  _queue = enqueueDedup(_queue, entries)
  pump()
}

/**
 * 立即试听一条（设置面板用；忽略总开关，直接播放不走队列）。
 * 异步等待合约树/行情就绪并真实发声，返回结果供 UI 反馈。
 */
export async function speakBroadcastTest(
  code: string,
  name: string,
): Promise<TestSpeakResult> {
  const c = code.toUpperCase()
  let symbol = masterOf(c)
  if (!symbol) {
    await ensureTree(3000)
    symbol = masterOf(c)
  }
  let quote = symbol ? resolveQuote(symbol) : null
  if (!quote) {
    await ensureSnapshot()
    quote = symbol ? resolveQuote(symbol) : null
  }
  const text = quote ? buildBroadcastText(name, quote) : ""
  if (!text) return "no-data"
  const result = await playClip(text)
  return result === "none" ? "no-voice" : "ok"
}

/** 启动引擎（幂等；layout 挂载时调用一次） */
export function startVoiceBroadcastEngine(): void {
  if (typeof window === "undefined" || _started) return
  _started = true
  useVoiceBroadcastStore.getState().hydrate()
  _ticker = setInterval(onTick, TICK_MS)
}

/** 停止引擎（测试/HMR 用） */
export function stopVoiceBroadcastEngine(): void {
  if (_ticker) clearInterval(_ticker)
  _ticker = null
  _started = false
  _lastBuckets.clear()
  _queue = []
  _speaking = false
}
