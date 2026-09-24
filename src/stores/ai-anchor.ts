"use client"

/**
 * AI 看盘主播状态管理
 *
 * 任务本体常驻后端（跨页面/关浏览器不中断），前端 store 只持有：
 * - 配置草稿（localStorage 持久化，回页恢复表单）
 * - 任务状态 + 播报列表（挂载时从后端拉取，运行中靠 WS anchor_broadcast 增量更新）
 * - 语音开关/音色/语速（默认开，跳页后播报仍朗读）
 *
 * 持久化与兜底常量见 lib/ai-anchor-persist.ts。
 */

import { create } from "zustand"
import {
  clearAnchorPositionApi,
  getAnchorIndicatorsApi,
  getAnchorStatusApi,
  patchAnchorConfigApi,
  pauseAnchorApi,
  resumeAnchorApi,
  setAnchorPositionApi,
  startAnchorApi,
  stopAnchorApi,
  type AnchorBroadcast,
  type AnchorHorizon,
  type AnchorManualPosition,
  type AnchorParamSpec,
  type AnchorStartConfig,
  type AnchorStatus,
  type AnchorStrategy,
  type AnchorTask,
} from "@/lib/ai-anchor-api"
import {
  FALLBACK_INDICATOR_SCHEMA,
  applyVoiceSettings,
  loadDraft,
  loadVoiceEnabled,
  loadVoiceRate,
  loadVoiceURI,
  saveDraft,
  saveVoiceEnabled,
  saveVoiceRate,
  saveVoiceURI,
  type AnchorDraft,
} from "@/lib/ai-anchor-persist"
import { speakAnchor } from "@/lib/speech"
import { useAuthStore } from "@/stores/auth"

/** 播报列表内存上限（历史可随时从后端拉全量） */
const BROADCAST_CAP = 200

/** 播报去重指纹（WS 重连/兜底轮询可能重投） */
const _seenBroadcastIds = new Set<string>()

interface AiAnchorState {
  /** 配置草稿（localStorage 持久化） */
  draft: AnchorDraft
  /** 后端任务状态（null=从未创建） */
  task: AnchorTask | null
  /** 播报列表（新的在前） */
  broadcasts: AnchorBroadcast[]
  /** 指标参数 schema（后端下发） */
  indicatorSchema: Record<string, AnchorParamSpec[]>
  /** 请求进行中标记 */
  loading: boolean
  /** 操作（启动/暂停等）进行中标记 */
  acting: boolean
  /** 最近一次错误文案 */
  error: string | null
  /** 语音播报开关（默认开） */
  voiceEnabled: boolean
  /** 主播音色 voiceURI（null=自动选中文语音） */
  voiceURI: string | null
  /** 主播语速（0.5-1.5） */
  voiceRate: number
  /** 更新草稿并持久化 */
  patchDraft: (patch: Partial<AnchorDraft>) => void
  setVoiceEnabled: (enabled: boolean) => void
  setVoiceURI: (voiceURI: string | null) => void
  setVoiceRate: (rate: number) => void
  /** 拉取状态总览（挂载/兜底轮询） */
  fetchStatus: () => Promise<void>
  /** 拉取指标 schema */
  fetchIndicatorSchema: () => Promise<void>
  /** 启动主播（草稿 → 后端）；传 override 时用指定配置（暂停调参保存继续场景） */
  start: (override?: Partial<AnchorStartConfig>) => Promise<boolean>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  /** 运行中热更新配置：切换模型/操盘策略/交易风格（下一轮播报生效，不打断节奏） */
  patchConfig: (patch: {
    modelRowId?: string
    strategy?: AnchorStrategy
    horizon?: AnchorHorizon
  }) => Promise<boolean>
  /** 录入/更新手动持仓（下一轮播报起汇报持仓状态） */
  savePosition: (position: AnchorManualPosition) => Promise<boolean>
  /** 清除手动持仓（恢复普通播报） */
  clearPosition: () => Promise<void>
  /** WS anchor_broadcast 入口（market store 分发调用） */
  receiveWsBroadcast: (raw: Record<string, unknown>) => void
  /** 应用后端状态响应 */
  applyStatus: (status: AnchorStatus) => void
}

export const useAiAnchorStore = create<AiAnchorState>((set, get) => ({
  draft: typeof window !== "undefined" ? loadDraft() : { ...loadDraft() },
  task: null,
  broadcasts: [],
  indicatorSchema: FALLBACK_INDICATOR_SCHEMA,
  loading: false,
  acting: false,
  error: null,
  voiceEnabled: typeof window !== "undefined" ? loadVoiceEnabled() : true,
  voiceURI: typeof window !== "undefined" ? loadVoiceURI() : null,
  voiceRate: typeof window !== "undefined" ? loadVoiceRate() : 1,

  patchDraft: (patch) => {
    const next = { ...get().draft, ...patch }
    set({ draft: next })
    saveDraft(next)
  },

  setVoiceEnabled: (enabled) => {
    set({ voiceEnabled: enabled })
    saveVoiceEnabled(enabled)
  },

  setVoiceURI: (voiceURI) => {
    set({ voiceURI })
    applyVoiceSettings(voiceURI, get().voiceRate)
    saveVoiceURI(voiceURI)
  },

  setVoiceRate: (rate) => {
    const safe = Math.min(1.5, Math.max(0.5, rate))
    set({ voiceRate: safe })
    applyVoiceSettings(get().voiceURI, safe)
    saveVoiceRate(safe)
  },

  applyStatus: (status) => {
    for (const item of status.recent_broadcasts) {
      _seenBroadcastIds.add(item.id)
    }
    set({ task: status.task, broadcasts: status.recent_broadcasts })
  },

  fetchStatus: async () => {
    set({ loading: true, error: null })
    try {
      const status = await getAnchorStatusApi()
      get().applyStatus(status)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "加载主播状态失败" })
    } finally {
      set({ loading: false })
    }
  },

  fetchIndicatorSchema: async () => {
    try {
      const schema = await getAnchorIndicatorsApi()
      if (Object.keys(schema).length > 0) {
        set({ indicatorSchema: schema })
      }
    } catch {
      // 拉取失败沿用兜底 schema
    }
  },

  start: async (override) => {
    const { draft } = get()
    set({ acting: true, error: null })
    try {
      const config: AnchorStartConfig = {
        model_row_id: override?.model_row_id ?? draft.modelRowId,
        symbol: override?.symbol ?? draft.symbol.trim().toLowerCase(),
        timeframes: override?.timeframes ?? draft.timeframes,
        direction_mode: override?.direction_mode ?? draft.directionMode,
        horizon: override?.horizon ?? draft.horizon,
        bar_count: override?.bar_count ?? draft.barCount,
        interval_minutes: override?.interval_minutes ?? draft.intervalMinutes,
        indicators: override?.indicators ?? draft.indicators,
      }
      const status = await startAnchorApi(config)
      get().applyStatus(status)
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "启动失败" })
      return false
    } finally {
      set({ acting: false })
    }
  },

  pause: async () => {
    set({ acting: true, error: null })
    try {
      get().applyStatus(await pauseAnchorApi())
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "暂停失败" })
    } finally {
      set({ acting: false })
    }
  },

  resume: async () => {
    set({ acting: true, error: null })
    try {
      get().applyStatus(await resumeAnchorApi())
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "恢复失败" })
    } finally {
      set({ acting: false })
    }
  },

  stop: async () => {
    set({ acting: true, error: null })
    try {
      get().applyStatus(await stopAnchorApi())
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "停止失败" })
    } finally {
      set({ acting: false })
    }
  },

  patchConfig: async (patch) => {
    set({ acting: true, error: null })
    try {
      const status = await patchAnchorConfigApi({
        model_row_id: patch.modelRowId,
        strategy: patch.strategy,
        horizon: patch.horizon,
      })
      // 热更接口只回任务状态，只更新 task 避免清空播报历史
      set({ task: status.task })
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "更新配置失败" })
      return false
    } finally {
      set({ acting: false })
    }
  },

  savePosition: async (position) => {
    set({ acting: true, error: null })
    try {
      const status = await setAnchorPositionApi(position)
      // 持仓接口只回任务状态（播报列表为空），只更新 task 避免清空历史
      set({ task: status.task })
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "保存持仓失败" })
      return false
    } finally {
      set({ acting: false })
    }
  },

  clearPosition: async () => {
    set({ acting: true, error: null })
    try {
      const status = await clearAnchorPositionApi()
      set({ task: status.task })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "清除持仓失败" })
    } finally {
      set({ acting: false })
    }
  },

  receiveWsBroadcast: (raw) => {
    // 盘模式过滤：live/virtual 各自独立任务，只收当前会话的播报
    const sessionMode = useAuthStore.getState().user?.trading_mode ?? "live"
    if (String(raw.trading_mode ?? "live") !== sessionMode) return
    const broadcast = raw.broadcast as AnchorBroadcast | undefined
    if (!broadcast?.id) return

    const { task, broadcasts, voiceEnabled } = get()
    if (_seenBroadcastIds.has(broadcast.id)) return
    _seenBroadcastIds.add(broadcast.id)
    if (_seenBroadcastIds.size > BROADCAST_CAP) {
      const first = _seenBroadcastIds.values().next().value
      if (first) _seenBroadcastIds.delete(first)
    }

    const nextTask: AnchorTask | null = task
      ? { ...task, next_run_at: (raw.next_run_at as string | null) ?? task.next_run_at }
      : task
    const nextBroadcasts = [broadcast, ...broadcasts]
    if (nextBroadcasts.length > BROADCAST_CAP) nextBroadcasts.length = BROADCAST_CAP
    set({ task: nextTask, broadcasts: nextBroadcasts })

    // 语音播报：跨页面持续（开关默认开）
    speakAnchor(
      {
        symbol: broadcast.symbol,
        direction: broadcast.direction,
        action: broadcast.action,
        commentary: broadcast.model_error ? "" : broadcast.commentary,
      },
      voiceEnabled,
    )
  },
}))

// 客户端初始化：把持久化的音色/语速注入 speech 模块（SSR 安全）
if (typeof window !== "undefined") {
  applyVoiceSettings(loadVoiceURI(), loadVoiceRate())
}
