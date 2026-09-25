"use client"

import { create } from "zustand"
import {
  createAITradingTask,
  fetchEquitySeries,
  fetchProfitBars,
  listAITradingDecisions,
  listAITradingTasks,
  listAITradingTrades,
  pauseAITradingTask,
  runAITradingOnce,
  startAITradingTask,
  stopAITradingTask,
  switchTaskModel,
  deleteAITradingTask,
  updateAITradingTask,
  updateAITradingTaskRules,
  type AITradingDecision,
  type AITradingTask,
  type CreateTaskPayload,
  type EquityPoint,
  type ProfitCloseBar,
  type UpdateTaskPayload,
  type UpdateTaskRulesPayload,
} from "@/lib/ai-trading-api"

interface AITradingState {
  tasks: AITradingTask[]
  equitySeries: Record<string, EquityPoint[]>
  /** 总收益柱：平仓 + 浮盈 */
  profitBars: ProfitCloseBar[]
  profitTotalRealized: number
  profitTotalUnrealized: number
  profitTotalPnl: number
  profitOpenCount: number
  profitLoading: boolean
  loading: boolean
  error: string | null
  selectedTaskId: string | null
  decisions: AITradingDecision[]
  trades: Record<string, unknown>[]
  detailLoading: boolean
  /** silent=true：轮询刷新，不切换 loading 状态 */
  loadTasks: (opts?: { silent?: boolean }) => Promise<void>
  loadEquity: () => Promise<void>
  loadProfitBars: (opts?: { silent?: boolean }) => Promise<void>
  createTask: (payload: CreateTaskPayload) => Promise<AITradingTask>
  updateTask: (id: string, payload: UpdateTaskPayload) => Promise<AITradingTask>
  /** 无持仓时调整止盈/止损规则（运行中也允许） */
  updateRules: (
    id: string,
    payload: UpdateTaskRulesPayload,
  ) => Promise<AITradingTask>
  startTask: (id: string) => Promise<void>
  pauseTask: (id: string) => Promise<void>
  stopTask: (id: string, forceClose: boolean) => Promise<AITradingTask>
  /** 删除已结束且无持仓的任务 */
  deleteTask: (id: string) => Promise<void>
  runOnce: (id: string) => Promise<void>
  /** 切换任务模型并立即用新模型执行一次（接手操盘） */
  switchModel: (id: string, modelRowId: string) => Promise<void>
  selectTask: (id: string | null) => Promise<void>
  /** opts.silent：轮询刷新不闪 loading/错误 */
  refreshDetail: (opts?: { silent?: boolean }) => Promise<void>
}

/** AI 交易状态 */
export const useAITradingStore = create<AITradingState>((set, get) => ({
  tasks: [],
  equitySeries: {},
  profitBars: [],
  profitTotalRealized: 0,
  profitTotalUnrealized: 0,
  profitTotalPnl: 0,
  profitOpenCount: 0,
  profitLoading: false,
  loading: false,
  error: null,
  selectedTaskId: null,
  decisions: [],
  trades: [],
  detailLoading: false,

  loadTasks: async (opts) => {
    const silent = Boolean(opts?.silent)
    if (!silent) set({ loading: true, error: null })
    try {
      const data = await listAITradingTasks()
      set({ tasks: data.items, loading: false, error: null })
    } catch (err) {
      // 静默轮询失败不刷红、不改 loading，避免闪屏
      if (silent) return
      set({
        loading: false,
        error: err instanceof Error ? err.message : "加载失败",
      })
    }
  },

  loadEquity: async () => {
    const { tasks } = get()
    const ids = tasks.map((t) => t.id)
    if (ids.length === 0) {
      set({ equitySeries: {} })
      return
    }
    try {
      const data = await fetchEquitySeries(ids, 500)
      set({ equitySeries: data.series })
    } catch {
      // 曲线失败不阻断主列表
    }
  },

  loadProfitBars: async (opts) => {
    const silent = Boolean(opts?.silent)
    if (!silent) set({ profitLoading: true })
    try {
      const data = await fetchProfitBars(500)
      set({
        profitBars: data.items,
        profitTotalRealized: data.total_realized,
        profitTotalUnrealized: data.total_unrealized ?? 0,
        profitTotalPnl: data.total_pnl ?? data.total_realized,
        profitOpenCount: data.open_position_count ?? 0,
        profitLoading: false,
      })
    } catch {
      if (!silent) set({ profitLoading: false })
    }
  },

  createTask: async (payload) => {
    const task = await createAITradingTask(payload)
    await get().loadTasks()
    await get().loadEquity()
    await get().loadProfitBars()
    return task
  },

  updateTask: async (id, payload) => {
    const task = await updateAITradingTask(id, payload)
    await get().loadTasks()
    await get().loadEquity()
    return task
  },

  updateRules: async (id, payload) => {
    const task = await updateAITradingTaskRules(id, payload)
    await get().loadTasks()
    return task
  },

  startTask: async (id) => {
    await startAITradingTask(id)
    await get().loadTasks()
  },

  pauseTask: async (id) => {
    await pauseAITradingTask(id)
    await get().loadTasks()
  },

  stopTask: async (id, forceClose) => {
    const task = await stopAITradingTask(id, forceClose)
    await get().loadTasks()
    await get().loadEquity()
    await get().loadProfitBars()
    return task
  },
  deleteTask: async (id) => {
    await deleteAITradingTask(id)
    // 删除后清除选中态：避免抽屉指向已删除任务导致空面板
    if (get().selectedTaskId === id) {
      await get().selectTask(null)
    }
    await get().loadTasks()
    await get().loadEquity()
    await get().loadProfitBars()
  },

  runOnce: async (id) => {
    await runAITradingOnce(id)
    await get().loadTasks()
    await get().loadEquity()
    await get().loadProfitBars()
    if (get().selectedTaskId === id) {
      await get().refreshDetail()
    }
  },

  switchModel: async (id, modelRowId) => {
    await switchTaskModel(id, modelRowId)
    await get().loadTasks()
    await get().loadEquity()
    await get().loadProfitBars()
    if (get().selectedTaskId === id) {
      await get().refreshDetail()
    }
  },

  selectTask: async (id) => {
    set({ selectedTaskId: id, decisions: [], trades: [] })
    if (!id) return
    await get().refreshDetail()
  },

  refreshDetail: async (opts) => {
    const id = get().selectedTaskId
    if (!id) return
    // silent：抽屉打开期间的轮询刷新——不闪 loading/错误（新分析由列表动画呈现）
    const silent = Boolean(opts?.silent)
    if (!silent) set({ detailLoading: true })
    try {
      const [dec, trades] = await Promise.all([
        listAITradingDecisions(id, 50, 0),
        listAITradingTrades(id, 50, 0),
      ])
      set({
        decisions: dec.items,
        trades: trades.items,
        detailLoading: false,
      })
    } catch (err) {
      if (!silent) {
        set({
          detailLoading: false,
          error: err instanceof Error ? err.message : "加载详情失败",
        })
      }
    }
  },
}))
