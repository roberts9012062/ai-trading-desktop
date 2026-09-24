/**
 * 语音播报工具 —— Web Speech API
 *
 * 由大单预警设置中的 voice_enabled 开关驱动。
 * 镜像 lib/sound.ts 的"模块级设置注入 + 播放时判定"模式：
 * 布局层注入最新设置，大单命中时调用 speakBigOrder()。
 * 播报使用品种中文名（如「甲醇2609」），由 contract-names 映射。
 */

import { contractName } from "@/lib/contract-names"

// 内存中保存最新语音设置，默认关闭
let _speechSettings: { voice_enabled: boolean } = {
  voice_enabled: false,
}

/** 注入语音设置（由大单 store 在设置变更时调用） */
export function setSpeechSettings(s: { voice_enabled: boolean }): void {
  _speechSettings = s
}

/** 当前是否启用语音播报 */
export function isSpeechEnabled(): boolean {
  return _speechSettings.voice_enabled
}

/** 大单方向中文 */
function directionZh(direction: "buy" | "sell"): string {
  return direction === "buy" ? "多单" : "空单"
}

/**
 * 播报一条大单命中。
 * 开关关闭或浏览器不支持 speechSynthesis 时静默；
 * 调用失败静默吞掉，避免阻塞 UI。
 */
export function speakBigOrder(info: {
  symbol: string
  direction: "buy" | "sell"
  volume: number
}): void {
  if (!_speechSettings.voice_enabled) return
  if (typeof window === "undefined") return
  if (!("speechSynthesis" in window)) return
  try {
    const text = `${contractName(info.symbol)} ${directionZh(info.direction)} 大单 ${info.volume} 手`
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = "zh-CN"
    utter.rate = 1
    utter.volume = 1
    // 取一个中文语音（如有）
    const voices = window.speechSynthesis.getVoices()
    const zh = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh"))
    if (zh) utter.voice = zh
    window.speechSynthesis.cancel() // 避免堆积
    window.speechSynthesis.speak(utter)
  } catch {
    // 自动播放策略限制 / 构造失败：忽略
  }
}

/**
 * 播报一条任务下单/平仓成交（AI 看盘任务预警）。
 * enabled 由任务预警自己的 voice_enabled 开关传入——模块级 _speechSettings
 * 跟随的是大单预警设置，任务预警不应受其牵连（大单语音关、任务语音开时也要播）。
 */
export function speakTaskOrder(
  info: {
    symbol: string
    direction: "buy" | "sell"
    offset: "open" | "close"
    qty: number
  },
  enabled: boolean,
): void {
  if (!enabled) return
  if (typeof window === "undefined") return
  if (!("speechSynthesis" in window)) return
  try {
    const action =
      info.offset === "close"
        ? "平仓"
        : info.direction === "buy"
          ? "开多"
          : "开空"
    const text = `任务${action} ${contractName(info.symbol)} ${info.qty} 手`
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = "zh-CN"
    utter.rate = 1
    utter.volume = 1
    const voices = window.speechSynthesis.getVoices()
    const zh = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh"))
    if (zh) utter.voice = zh
    window.speechSynthesis.cancel() // 避免堆积
    window.speechSynthesis.speak(utter)
  } catch {
    // 忽略
  }
}

/**
 * AI 看盘主播语音播报 —— 云端自然音色优先，本地 Web Speech 回退。
 *
 * 云端音色（voiceURI 以 "cloud:" 前缀表示）经后端 edge-tts 代理微软
 * 神经网络音色（云希/晓晓等）合成 mp3 播放，任何浏览器可用；
 * 未选择音色（自动）时默认云端云希，云端失败回退本地中文语音。
 * 音色/语速由用户在主播面板选择，模块级注入。
 */

import { synthesizeAnchorTtsApi } from "@/lib/ai-anchor-api"

// 主播音色设置（模块级注入，默认自动：云端云希 + 本地回退）
let _anchorVoiceSettings: { voiceURI: string | null; rate: number } = {
  voiceURI: null,
  rate: 1,
}

/** 云端音色 voiceURI 前缀（后接音色 ID，如 cloud:zh-CN-YunxiNeural） */
export const ANCHOR_CLOUD_VOICE_PREFIX = "cloud:"

/** 自动模式默认云端音色 */
const DEFAULT_CLOUD_VOICE = "zh-CN-YunxiNeural"

/** 当前正在播放的云端音频（新播报到达时停掉旧的） */
let _currentAudio: HTMLAudioElement | null = null
let _currentAudioUrl: string | null = null
/** 当前云端段的完成回调（被打断时手动 resolve，避免播放 promise 悬挂） */
let _currentAudioSettle: ((ok: boolean) => void) | null = null
/** 云端播放队列令牌：新播报开始时 ++，旧队列据此自行退出 */
let _cloudSeq = 0
/** 本地朗读队列令牌：同上 */
let _localSeq = 0

/**
 * 长文本分段上限。浏览器 speechSynthesis 对长 utterance 会无声截断
 * （大约 200 字 / 15 秒后直接停住），云端长文本也容易合成超时，
 * 所以主播文案必须切成小段、逐段链式播放才能读完整。
 */
const LOCAL_CHUNK_MAX = 100
/** 后端 edge-tts 单次限 500 字符，留余量同时缩短单段合成耗时 */
const CLOUD_CHUNK_MAX = 300

/**
 * 把长文本切成语音引擎能稳定读完的小段：
 * 优先在句末标点切，长句退到逗号级停顿，超过 maxLen 才硬切。
 */
function chunkText(text: string, maxLen: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return []
  const chunks: string[] = []
  let buf = ""
  const flush = () => {
    const part = buf.trim()
    if (part) chunks.push(part)
    buf = ""
  }
  for (const ch of normalized) {
    buf += ch
    // 句末标点在段长达到约 1/3 上限后即收段；逗号级停顿需积累更长；超上限硬切
    if ("。！？；\n".includes(ch) && buf.length >= Math.ceil(maxLen * 0.35)) flush()
    else if ("，、：,.!?;".includes(ch) && buf.length >= Math.ceil(maxLen * 0.6)) flush()
    else if (buf.length >= maxLen) flush()
  }
  flush()
  return chunks
}

/** 注入主播音色设置（由 ai-anchor store 在初始化/变更时调用） */
export function setAnchorVoiceSettings(s: { voiceURI: string | null; rate: number }): void {
  _anchorVoiceSettings = s
}

/** 停掉当前云端音频段（不动队列令牌，打断旧段并 resolve 其播放 promise） */
function stopCurrentCloudAudio(): void {
  const settle = _currentAudioSettle
  const audio = _currentAudio
  const url = _currentAudioUrl
  _currentAudio = null
  _currentAudioUrl = null
  _currentAudioSettle = null
  if (audio) {
    try {
      audio.pause()
    } catch {
      // 忽略
    }
  }
  if (url) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // 忽略
    }
  }
  if (settle) settle(false)
}

/** 播放单个云端音频段；resolve(true)=自然播完，false=失败或被打断 */
function playCloudAudioBlob(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    let url = ""
    try {
      url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      _currentAudio = audio
      _currentAudioUrl = url
      let settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        if (_currentAudio === audio) _currentAudio = null
        if (_currentAudioUrl === url) _currentAudioUrl = null
        if (_currentAudioSettle === settle) _currentAudioSettle = null
        try {
          URL.revokeObjectURL(url)
        } catch {
          // 忽略
        }
        resolve(ok)
      }
      _currentAudioSettle = settle
      audio.onended = () => settle(true)
      audio.onerror = () => settle(false)
      void audio.play().catch(() => settle(false))
    } catch {
      if (url) {
        try {
          URL.revokeObjectURL(url)
        } catch {
          // 忽略
        }
      }
      resolve(false)
    }
  })
}

/**
 * 云端合成并分段播放；成功 true，失败 false（调用方回退本地）。
 * 播当前段的同时预取下一段，减少段间停顿；首段失败说明云端不可用，
 * 回退本地，中段失败只跳过该段继续读，不重头。
 */
async function playCloudTts(text: string, voiceId: string, rate: number): Promise<boolean> {
  const chunks = chunkText(text, CLOUD_CHUNK_MAX)
  if (chunks.length === 0) return true
  const seq = ++_cloudSeq
  const fetchChunk = (i: number): Promise<Blob | null> => {
    const part = chunks[i]
    if (part === undefined) return Promise.resolve(null)
    return synthesizeAnchorTtsApi(part, voiceId, rate)
      .then((blob) => (blob && blob.size > 0 ? blob : null))
      .catch(() => null)
  }

  let pending: Promise<Blob | null> | null = fetchChunk(0)
  for (let i = 0; i < chunks.length; i++) {
    const blob = pending ? await pending : null
    if (seq !== _cloudSeq) return true // 已被更新的播报取代
    pending = i + 1 < chunks.length ? fetchChunk(i + 1) : null
    if (!blob) {
      if (i === 0) return false
      continue
    }
    if (i === 0) stopCurrentCloudAudio() // 新段就绪后再打断旧播报，避免静音空档
    const ok = await playCloudAudioBlob(blob)
    if (seq !== _cloudSeq) return true
    if (!ok && i === 0) return false
  }
  return true
}

/**
 * 本地 Web Speech 分段播放：按 voiceURI 精确匹配，缺失回退任意中文语音。
 * 逐段链式朗读（onend 触发下一段），单段被中断/出错时只要令牌仍有效就继续读。
 */
function speakLocal(text: string): void {
  if (typeof window === "undefined") return
  if (!("speechSynthesis" in window)) return
  const chunks = chunkText(text, LOCAL_CHUNK_MAX)
  if (chunks.length === 0) return
  const seq = ++_localSeq
  stopCurrentCloudAudio() // 本地出声前停掉云端残留，避免两引擎重叠朗读
  try {
    // 先令牌失效再 cancel：cancel 触发旧队列 onerror 时，旧链因 seq 不匹配直接退出
    window.speechSynthesis.cancel()
  } catch {
    // 忽略
  }
  const uri = _anchorVoiceSettings.voiceURI
  const voices = window.speechSynthesis.getVoices()
  const voice = uri
    ? voices.find((v) => v.voiceURI === uri) ??
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh"))
    : voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh"))
  const speakNext = (i: number): void => {
    if (seq !== _localSeq) return
    if (i >= chunks.length) return
    try {
      const utter = new SpeechSynthesisUtterance(chunks[i])
      utter.lang = "zh-CN"
      utter.rate = _anchorVoiceSettings.rate
      utter.volume = 1
      if (voice) utter.voice = voice
      utter.onend = () => speakNext(i + 1)
      utter.onerror = () => speakNext(i + 1)
      window.speechSynthesis.speak(utter)
    } catch {
      // 忽略
    }
  }
  speakNext(0)
}

export function speakAnchor(
  info: {
    symbol: string
    direction: "long" | "short" | "neutral"
    action: "trade" | "wait"
    commentary: string
  },
  enabled: boolean,
): void {
  if (!enabled) return
  if (typeof window === "undefined") return
  const directionText =
    info.direction === "long" ? "看多" : info.direction === "short" ? "看空" : "中性"
  const actionText = info.action === "trade" ? "建议做单" : "建议观望"
  // 与后端 _MAX_COMMENTARY=2000 对齐：分段播放机制能读完长文案，只防异常超长
  const commentary = info.commentary.slice(0, 2000)
  const text = `${contractName(info.symbol)} ${directionText}，${actionText}。${commentary}`

  // 新播报会话开始：作废云端/本地两条旧队列并停掉本地当前朗读；
  // 云端旧音频由新播报首段就绪时接管停掉，避免静音空档。
  _cloudSeq++
  _localSeq++
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      // 忽略
    }
  }

  const { voiceURI, rate } = _anchorVoiceSettings
  if (voiceURI && voiceURI.startsWith(ANCHOR_CLOUD_VOICE_PREFIX)) {
    // 明确选了云端音色：失败仍回退本地，保证播报不丢
    void playCloudTts(text, voiceURI.slice(ANCHOR_CLOUD_VOICE_PREFIX.length), rate).then(
      (ok) => {
        if (!ok) speakLocal(text)
      },
    )
    return
  }
  if (!voiceURI) {
    // 自动：优先云端云希，不可用回退本地
    void playCloudTts(text, DEFAULT_CLOUD_VOICE, rate).then((ok) => {
      if (!ok) speakLocal(text)
    })
    return
  }
  speakLocal(text)
}
