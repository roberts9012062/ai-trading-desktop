"use client"

/**
 * AI 看盘行情 store —— 任务选择 / 任务列表轮询 / K 线交易标记 / 记录面板数据
 *
 * 与 ai-trading store 分立：本页以「看任务」为主，选中任务驱动全局
 * activeContract（K线/盘口复用行情组件）并按任务隔离加载交易标记。
 * trades/decisions 供右下记录面板与底部收益柱面板共享。
 * 选中任务持久化到 localStorage，再次进入直接定位到上次的任务。
 */

import { create } from "zustand"
import {
  listAITradingDecisions,
  listAITradingTasks,
  listAITradingTrades,
  listTaskTradeMarks,
  type AITradingDecision,
  type AITradingTask,
  type TaskTradeMark,
} from "@/lib/ai-trading-api"
import { useAppStore } from "@/stores/app"
import { activeHunterChild } from "@/lib/hunter/task-visibility"

/** 已加载过的标记缓存（task_id → marks），切回任务时秒出 */
const _marksCache = new Map<string, TaskTradeMark[]>()
const _MARKS_CACHE_LIMIT = 20

/** 上次选中任务 id 的 localStorage key（再次进入直接定位） */
const _SELECTED_TASK_KEY = "ai-market-selected-task"

function readSavedTaskId(): string | null {
  try {
    return localStorage.getItem(_SELECTED_TASK_KEY)
  } catch {
    return null
  }
}

function writeSavedTaskId(id: string | null): void {
  try {
    if (id) localStorage.setItem(_SELECTED_TASK_KEY, id)
    else localStorage.removeItem(_SELECTED_TASK_KEY)
  } catch {
    // localStorage 不可用时静默忽略
  }
}

interface AiMarketState {
  /** 任务列表（AI + 量化混合，前端分组） */
  tasks: AITradingTask[]
  tasksLoading: boolean
  tasksLoaded: boolean
  /** 当前选中任务 id */
  selectedTaskId: string | null
  /** 选中任务的 K 线交易标记（按任务隔离） */
  marks: TaskTradeMark[]
  marksLoading: boolean
  /** 选中任务的交易记录（含 realized_pnl，供记录面板与收益柱） */
  trades: Record<string, unknown>[]
  /** 选中任务的分析记录 */
  decisions: AITradingDecision[]
  recordsLoading: boolean
  /** 轮询/加载 */
  loadTasks: (silent?: boolean) => Promise<void>
  /** 选中任务：切全局合约 + 拉标记与记录（标记带缓存） */
  selectTask: (id: string) => void
  /** 强制刷新选中任务的标记（预警命中/手动刷新时用） */
  refreshMarks: () => Promise<void>
  /** 加载选中任务的交易/分析记录 */
  loadRecords: () => Promise<void>
  /** 预警触发的记录刷新信号（seq 递增，页面据此重拉） */
  recordsSeq: number
  bumpRecords: () => void
}

export const useAiMarketStore = create<AiMarketState>((set, get) => {
  let tasksRequest = 0
  let tasksApplied = 0
  async function fetchMarks(taskId: string): Promise<void> {
    set({ marksLoading: true })
    try {
      const r = await listTaskTradeMarks(taskId)
      const items = r.items ?? []
      _marksCache.set(taskId, items)
      if (_marksCache.size > _MARKS_CACHE_LIMIT) {
        const first = _marksCache.keys().next().value
        if (first) _marksCache.delete(first)
      }
      // 异步期间可能已切换任务，仅写回仍选中的
      if (get().selectedTaskId === taskId) {
        set({ marks: items, marksLoading: false })
      } else {
        set({ marksLoading: false })
      }
    } catch {
      if (get().selectedTaskId === taskId) {
        set({ marks: [], marksLoading: false })
      } else {
        set({ marksLoading: false })
      }
    }
  }

  return {
    tasks: [],
    tasksLoading: false,
    tasksLoaded: false,
    selectedTaskId: null,
    marks: [],
    marksLoading: false,
    trades: [],
    decisions: [],
    recordsLoading: false,

    loadTasks: async (silent = false) => {
      const request = ++tasksRequest
      if (!silent) set({ tasksLoading: true })
      try {
        const r = await listAITradingTasks()
        if (request < tasksApplied) return
        tasksApplied = request
        // Match AI trading's hunter cleanup; live holdings remain visible even
        // when search has stopped. Keep ordinary task history unchanged.
        const tasks = (r.items ?? []).filter(t => t.strategy_type !== "multi_cycle_hunter" || activeHunterChild(t))
        const visibleIds = new Set(tasks.map(t => t.id))
        for (const id of _marksCache.keys()) if (!visibleIds.has(id)) _marksCache.delete(id)
        const prevSelected = get().selectedTaskId
        // 任务被删除/首次进入：优先恢复上次选中的任务，否则回落第一个
        const stillThere =
          prevSelected && tasks.some((t) => t.id === prevSelected)
        set({ tasks, tasksLoaded: true })
        if (stillThere) return
        const savedId = readSavedTaskId()
        if (savedId && tasks.some((t) => t.id === savedId)) {
          get().selectTask(savedId)
          return
        }
        if (tasks.length > 0) {
          get().selectTask(tasks[0].id)
        } else {
          set({ selectedTaskId: null, marks: [], trades: [], decisions: [] })
          writeSavedTaskId(null)
        }
      } catch {
        // 静默失败：保留旧列表
      } finally {
        if (!silent) set({ tasksLoading: false })
      }
    },

    selectTask: (id) => {
      const task = get().tasks.find((t) => t.id === id)
      if (!task) return
      set({ selectedTaskId: id, trades: [], decisions: [] })
      writeSavedTaskId(id)
      // 选中任务驱动全局合约：K线/盘口/成交组件按 activeContract 工作
      useAppStore.getState().setActiveContract(task.symbol)
      const cached = _marksCache.get(id)
      set({ marks: cached ?? [] })
      void fetchMarks(id)
      void get().loadRecords()
    },

    refreshMarks: async () => {
      const id = get().selectedTaskId
      if (!id) return
      await fetchMarks(id)
    },

    loadRecords: async () => {
      const id = get().selectedTaskId
      if (!id) return
      set({ recordsLoading: true })
      try {
        const [t, d] = await Promise.all([
          listAITradingTrades(id, 50, 0),
          listAITradingDecisions(id, 50, 0),
        ])
        // 异步期间切换任务则丢弃
        if (get().selectedTaskId !== id) return
        set({ trades: t.items ?? [], decisions: d.items ?? [] })
      } catch {
        if (get().selectedTaskId === id) {
          set({ trades: [], decisions: [] })
        }
      } finally {
        set({ recordsLoading: false })
      }
    },

    recordsSeq: 0,
    bumpRecords: () =>
      set((s) => ({ recordsSeq: s.recordsSeq + 1 })),
  }
})
