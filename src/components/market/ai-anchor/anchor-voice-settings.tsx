"use client";

/**
 * 主播语音设置 —— 云端自然音色/本地音色选择 + 语速调节 + 试听
 *
 * 云端音色(云希/晓晓等微软神经网络音色)由后端 edge-tts 代理合成,
 * 任何浏览器可用且效果自然;本地音色走浏览器 Web Speech(仅回退用)。
 */

import { useEffect, useMemo, useState } from "react"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import { speakAnchor, ANCHOR_CLOUD_VOICE_PREFIX } from "@/lib/speech"
import { getAnchorVoicesApi, type AnchorCloudVoice } from "@/lib/ai-anchor-api"

/** 试听文案 */
const SAMPLE_COMMENTARY = "均线多头排列，MACD 零轴上方金叉，回踩均线可轻仓试多。"

/** 云端音色兜底列表(后端 /voices 为准,拉取失败时用) */
const FALLBACK_CLOUD_VOICES: AnchorCloudVoice[] = [
  { id: "zh-CN-YunxiNeural", name: "云希", desc: "男 · 阳光沉稳" },
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", desc: "女 · 温暖亲切" },
  { id: "zh-CN-YunjianNeural", name: "云健", desc: "男 · 浑厚磁性" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", desc: "女 · 甜美活泼" },
  { id: "zh-CN-YunyangNeural", name: "云扬", desc: "男 · 新闻播报" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰", desc: "女 · 沉稳干练" },
]

export function AnchorVoiceSettings(): React.JSX.Element {
  const voiceEnabled = useAiAnchorStore((s) => s.voiceEnabled)
  const voiceURI = useAiAnchorStore((s) => s.voiceURI)
  const voiceRate = useAiAnchorStore((s) => s.voiceRate)
  const setVoiceEnabled = useAiAnchorStore((s) => s.setVoiceEnabled)
  const setVoiceURI = useAiAnchorStore((s) => s.setVoiceURI)
  const setVoiceRate = useAiAnchorStore((s) => s.setVoiceRate)
  const [cloudVoices, setCloudVoices] = useState<AnchorCloudVoice[]>(FALLBACK_CLOUD_VOICES)
  const [localVoices, setLocalVoices] = useState<SpeechSynthesisVoice[]>([])

  // 云端音色列表(失败沿用兜底)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const voices = await getAnchorVoicesApi()
        if (!cancelled && voices.length > 0) setCloudVoices(voices)
      } catch {
        // 沿用兜底列表
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 本地语音列表异步加载（Chrome 需监听 voiceschanged）
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return
    const load = (): void => setLocalVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener("voiceschanged", load)
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load)
  }, [])

  // 本地音色中文排前面
  const sortedLocal = useMemo(() => {
    return [...localVoices].sort((a, b) => {
      const aZh = a.lang.toLowerCase().startsWith("zh") ? 0 : 1
      const bZh = b.lang.toLowerCase().startsWith("zh") ? 0 : 1
      return aZh - bZh || a.name.localeCompare(b.name)
    })
  }, [localVoices])

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 space-y-1.5">
      <label className="flex items-center justify-between gap-2 cursor-pointer">
        <span className="text-[11px] text-[var(--text-primary)]">语音播报</span>
        <input
          type="checkbox"
          checked={voiceEnabled}
          onChange={(e) => setVoiceEnabled(e.target.checked)}
          className="accent-[var(--primary)]"
        />
      </label>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[var(--text-muted)] shrink-0">音色</span>
        <select
          value={voiceURI ?? ""}
          onChange={(e) => setVoiceURI(e.target.value || null)}
          className="flex-1 min-w-0 h-7 px-1.5 text-[11px] rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] cursor-pointer"
        >
          <option value="">自动（云端云希 → 本地回退）</option>
          <optgroup label="云端自然音色（推荐）">
            {cloudVoices.map((v) => (
              <option key={v.id} value={ANCHOR_CLOUD_VOICE_PREFIX + v.id}>
                {v.name}（{v.desc}）
              </option>
            ))}
          </optgroup>
          <optgroup label="浏览器本地音色">
            {sortedLocal.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}（{v.lang}）
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[var(--text-muted)] shrink-0">语速</span>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.05}
          value={voiceRate}
          onChange={(e) => setVoiceRate(Number(e.target.value))}
          className="flex-1 accent-[var(--primary)]"
        />
        <span className="text-[10px] font-num text-[var(--text-secondary)] w-8 text-right">
          {voiceRate.toFixed(2)}
        </span>
      </div>

      <button
        type="button"
        onClick={() =>
          speakAnchor(
            {
              symbol: "rb2610",
              direction: "long",
              action: "trade",
              commentary: SAMPLE_COMMENTARY,
            },
            true,
          )
        }
        className="w-full h-7 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
      >
        试听当前音色
      </button>
      <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        云端自然音色由服务端合成(微软神经网络语音);不可用时自动回退本地音色。
      </div>
    </div>
  )
}
