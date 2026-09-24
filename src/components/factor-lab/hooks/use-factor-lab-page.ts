"use client"

/**
 * 因子实验室页面状态与操作
 */

import { useCallback, useRef, useState } from "react"
import type { SearchFormPayload } from "../factor-search-form"
import {
  addFactorFavorite,
  backtestFactor,
  deleteFactorFavorite,
  deleteFactorHistory,
  llmGenerateFactors,
  saveFactorHistory,
  searchFactors,
  type Champion,
  type FactorBacktestResult,
  type FactorMetrics,
  type SearchResult,
} from "@/lib/factor-lab-api"
import { createAITradingTask as createTask, switchTaskSite } from "@/lib/ai-trading-api"
import { searchFactorsLocal, backtestFactorLocal } from "@/lib/local-factor"
import { useFactorLabData } from "./use-factor-data"
import {
  buildComboTaskPayload,
  buildFactorTaskPayload,
  defaultSearchPayload,
  isLocalOnly,
} from "./factor-helpers"

/** 本地引擎类型:服务端 / 本地 CPU(Pyodide) / 本地 GPU(WebGPU 粗排+内核精算) */
export type FactorEngine = "server" | "cpu" | "gpu"

/** 一次性迁移:旧键 qh_factor_local("0"/"1") → qh_factor_engine("server"|"cpu"|"gpu") */
function readEngine(): FactorEngine {
  if (typeof window === "undefined") return "cpu"
  try {
    const v = localStorage.getItem("qh_factor_engine")
    if (v === "server" || v === "cpu" || v === "gpu") return v
    const old = localStorage.getItem("qh_factor_local")
    if (old === "0") return "server"
    if (old === "1") return "cpu"
  } catch {
    // 忽略存储异常
  }
  return "cpu" // 与旧默认(本地引擎)一致
}

/** 收藏入参（Champion 或历史记录都可适配） */
export interface FavoriteInput {
  tokens: number[]
  text: string
  symbol: string
  timeframe: string
  composite: number
  metrics: Partial<FactorMetrics>
}

export interface FactorLabPageState {
  loading: boolean
  btLoading: boolean
  genLoading: boolean
  result: SearchResult | null
  selected: Champion | null
  bt: FactorBacktestResult | null
  error: string | null
  lastReq: SearchFormPayload | null
  building: boolean
  buildMsg: string | null
  symbol: string
  setSymbol: (s: string) => void
  setBuildMsg: (s: string | null) => void
  handleSearch: (p: SearchFormPayload) => Promise<void>
  handleEvolve: () => Promise<void>
  /** 计算引擎三态与进度提示 */
  engine: FactorEngine
  setEngine: (v: FactorEngine) => void
  progressNote: string | null
  /** 取消本地搜索/回测(terminate 本地计算 worker;服务端请求无法客户端取消) */
  cancelLocalSearch: () => void
  handleGenerate: (payload: {
    model_row_id: string
    user_hint: string
  }) => Promise<void>
  selectFactor: (c: Champion, p?: SearchFormPayload) => Promise<void>
  handleBuildTask: () => Promise<void>
  handleComboMount: (champions: Champion[]) => Promise<void>
  handleFavoriteChampion: (c: Champion) => Promise<void>
  handleFavoriteHistory: (c: FavoriteInput) => Promise<void>
  /** 弹窗保存：选名称与文件夹后收藏 */
  saveFavorite: (
    item: FavoriteInput,
    opts?: { name?: string; folderId?: string | null },
  ) => Promise<void>
  /** 收藏默认名（品种-年化收益） */
  defaultFavoriteName: (item: FavoriteInput) => string
  deleteHistory: (id: string) => Promise<void>
  deleteFavorite: (id: string) => Promise<void>
}

function errOf(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

/** P1-5 防御:防过拟合开启的口径下,无样本外验证信息的记录不得直接挂载/收藏
 *  (旧口径历史/异常记录兜底;正常搜索的冠军与 overfit_warning 回退都会带相应字段) */
function lacksOosInfo(
  metrics: Partial<FactorMetrics> | undefined,
  trainRatio: number | undefined,
): boolean {
  const guarded = (trainRatio ?? 0) > 0
  return guarded && !metrics?.test_metrics && !metrics?.overfit_warning
}

/** 页面状态 hook */
export function useFactorLabPage(): FactorLabPageState & ReturnType<typeof useFactorLabData> {
  const [loading, setLoading] = useState(false)
  const [btLoading, setBtLoading] = useState(false)
  const [genLoading, setGenLoading] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [selected, setSelected] = useState<Champion | null>(null)
  const [bt, setBt] = useState<FactorBacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastReq, setLastReq] = useState<SearchFormPayload | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildMsg, setBuildMsg] = useState<string | null>(null)
  const [symbol, setSymbol] = useState("")
  // 计算引擎三态;持久化用户选择(qh_factor_engine,自旧键一次性迁移)
  const [engine, setEngineState] = useState<FactorEngine>(readEngine)
  const [progressNote, setProgressNote] = useState<string | null>(null)
  const setEngine = useCallback((v: FactorEngine) => {
    setEngineState(v)
    try {
      localStorage.setItem("qh_factor_engine", v)
      localStorage.removeItem("qh_factor_local")
    } catch {
      // 忽略存储异常
    }
  }, [])
  const cancelLocalSearch = useCallback(() => {
    void import("@/lib/py-worker").then(({ cancelPyWorker }) =>
      cancelPyWorker("已取消本地搜索"),
    )
  }, [])
  const data = useFactorLabData(symbol)

  const refreshHistory = data.refreshHistory
  const refreshFavorites = data.refreshFavorites
  const contractNameOf = data.contractNameOf

  // 快速连点多个 champion 时的竞态保护:只认最新一次选择。否则后发先至会出现
  // 「选中 A、显示 B 的回测」,且旧请求的 finally 会提前关掉新请求的 loading
  const selectSeqRef = useRef(0)

  const selectFactor = useCallback(
    async (c: Champion, p?: SearchFormPayload): Promise<void> => {
      const seq = ++selectSeqRef.current
      setSelected(c)
      setBt(null)
      setBtLoading(true)
      const sym = p?.symbol ?? lastReq?.symbol ?? result?.symbol ?? symbol
      const tf = p?.timeframe ?? lastReq?.timeframe ?? result?.timeframe ?? "1d"
      // 与触发本次选择时的搜索/表单保持同一区间（含长历史模式）
      const startDate = p?.start_date ?? lastReq?.start_date
      const endDate = p?.end_date ?? lastReq?.end_date
      try {
        let res: FactorBacktestResult
        // 本地引擎:单因子回测也在本机计算(与搜索同一份 K 线)
        if (engine !== "server") {
          res = await backtestFactorLocal(
            {
              symbol: sym,
              timeframe: tf,
              factor_tokens: c.tokens,
              ...(startDate && endDate ? { start_date: startDate, end_date: endDate } : {}),
            },
            setProgressNote,
          )
        } else {
          res = await backtestFactor({
            symbol: sym,
            timeframe: tf,
            factor_tokens: c.tokens,
            ...(startDate && endDate ? { start_date: startDate, end_date: endDate } : {}),
          })
        }
        if (seq !== selectSeqRef.current) return
        setBt(res)
      } catch (e) {
        if (seq !== selectSeqRef.current) return
        setError(errOf(e, "回测失败"))
      } finally {
        if (seq === selectSeqRef.current) {
          setBtLoading(false)
          setProgressNote(null)
        }
      }
    },
    [lastReq, result, symbol, engine],
  )

  async function applySearchResult(
    r: SearchResult,
    p: SearchFormPayload,
  ): Promise<void> {
    setResult(r)
    setLastReq(p)
    setSymbol(p.symbol)
    if (r.champions[0]) await selectFactor(r.champions[0], p)
    void refreshHistory(p.symbol)
  }

  /**
   * 本地搜索结果 best-effort 落服务端历史(配套服务端 POST /api/factor-lab/history,
   * source="local"):端点未上线(404)/网络失败时静默跳过,不影响本地结果展示。
   */
  async function persistLocalHistory(
    r: SearchResult,
    p: SearchFormPayload,
    seedCount: number,
  ): Promise<void> {
    if (!r.champions.length) return
    try {
      const saved = await saveFactorHistory({
        symbol: p.symbol,
        timeframe: p.timeframe,
        champions: r.champions.slice(0, 20).map((c) => ({
          tokens: c.tokens,
          text: c.text,
          composite: c.composite,
          metrics: c.metrics,
        })),
        trials: p.population * p.generations + seedCount,
        bars: r.bars,
        config: {
          population: p.population,
          generations: p.generations,
          train_ratio: p.train_ratio,
          test_recent_bars: p.test_recent_bars,
          walk_forward_folds: p.walk_forward_folds,
          cost: p.cost,
          seed: p.seed,
          seed_count: seedCount,
          start_date: p.start_date ?? null,
          end_date: p.end_date ?? null,
        },
      })
      if (saved > 0) void refreshHistory(p.symbol)
    } catch {
      // 静默降级:历史面板只是少了本地条目,搜索本身已成功
    }
  }

  async function handleSearch(p: SearchFormPayload): Promise<void> {
    setLoading(true)
    setError(null)
    setProgressNote(null)
    setResult(null)
    setSelected(null)
    setBt(null)
    setLastReq(p)
    setSymbol(p.symbol)
    try {
      // 本地引擎(CPU/GPU):GP 搜索在本机计算;LLM 教练开启时仍走服务端
      if (engine !== "server" && !p.use_llm_coach) {
        const r = await searchFactorsLocal(
          {
            symbol: p.symbol,
            timeframe: p.timeframe,
            population: p.population,
            generations: p.generations,
            top_n: p.top_n,
            seed: p.seed,
            cost: p.cost,
            train_ratio: p.train_ratio,
            test_recent_bars: p.test_recent_bars,
            walk_forward_folds: p.walk_forward_folds,
            ...(p.enhanced ? { selection_v2: true, evolve_v2: true } : {}),
            ...(p.start_date && p.end_date ? { start_date: p.start_date, end_date: p.end_date } : {}),
          },
          setProgressNote,
          engine,
        )
        await applySearchResult(r, p)
        void persistLocalHistory(r, p, 0)
        return
      }
      const r = await searchFactors({
        symbol: p.symbol,
        timeframe: p.timeframe,
        population: p.population,
        generations: p.generations,
        top_n: p.top_n,
        seed: p.seed,
        cost: p.cost,
        use_llm_coach: p.use_llm_coach,
        model_row_id: p.model_row_id,
        train_ratio: p.train_ratio,
        test_recent_bars: p.test_recent_bars,
        walk_forward_folds: p.walk_forward_folds,
        ...(p.start_date && p.end_date
          ? { start_date: p.start_date, end_date: p.end_date }
          : {}),
      })
      await applySearchResult(r, p)
    } catch (e) {
      setError(errOf(e, "搜索失败"))
    } finally {
      setLoading(false)
      setProgressNote(null)
    }
  }

  async function handleEvolve(): Promise<void> {
    if (!lastReq || !result?.champions.length) return
    const seeds = result.champions.slice(0, 5).map((c) => c.tokens)
    const p = { ...lastReq }
    setLoading(true)
    setError(null)
    setProgressNote(null)
    try {
      // 本地引擎再进化:种子 token 直接透传,seed+1
      if (engine !== "server" && !p.use_llm_coach) {
        const r = await searchFactorsLocal(
          {
            symbol: p.symbol,
            timeframe: p.timeframe,
            population: p.population,
            generations: p.generations,
            top_n: p.top_n,
            seed: p.seed + 1,
            cost: p.cost,
            seed_tokens: seeds,
            train_ratio: p.train_ratio,
            test_recent_bars: p.test_recent_bars,
            walk_forward_folds: p.walk_forward_folds,
            ...(p.enhanced ? { selection_v2: true, evolve_v2: true } : {}),
            ...(p.start_date && p.end_date ? { start_date: p.start_date, end_date: p.end_date } : {}),
          },
          setProgressNote,
          engine,
        )
        await applySearchResult(r, { ...p, seed: p.seed + 1 })
        void persistLocalHistory(r, { ...p, seed: p.seed + 1 }, seeds.length)
        return
      }
      const r = await searchFactors({
        symbol: p.symbol,
        timeframe: p.timeframe,
        population: p.population,
        generations: p.generations,
        top_n: p.top_n,
        seed: p.seed + 1,
        cost: p.cost,
        seed_tokens: seeds,
        use_llm_coach: p.use_llm_coach,
        model_row_id: p.model_row_id,
        train_ratio: p.train_ratio,
        test_recent_bars: p.test_recent_bars,
        walk_forward_folds: p.walk_forward_folds,
        ...(p.start_date && p.end_date
          ? { start_date: p.start_date, end_date: p.end_date }
          : {}),
      })
      await applySearchResult(r, { ...p, seed: p.seed + 1 })
    } catch (e) {
      setError(errOf(e, "进化失败"))
    } finally {
      setLoading(false)
      setProgressNote(null)
    }
  }

  async function handleGenerate(payload: {
    model_row_id: string
    user_hint: string
  }): Promise<void> {
    const sym = (lastReq?.symbol || symbol).trim().toLowerCase()
    const tf = lastReq?.timeframe || "1d"
    if (!sym) {
      setError("请先选择合约")
      return
    }
    setGenLoading(true)
    setError(null)
    try {
      const r = await llmGenerateFactors({
        symbol: sym,
        timeframe: tf,
        model_row_id: payload.model_row_id,
        user_hint: payload.user_hint || undefined,
        seed_tokens: result?.champions.slice(0, 3).map((c) => c.tokens),
        ...(lastReq?.start_date && lastReq?.end_date
          ? { start_date: lastReq.start_date, end_date: lastReq.end_date }
          : {}),
      })
      const p = lastReq ?? defaultSearchPayload(sym, tf)
      await applySearchResult(r, p)
      if (!r.champions.length) setError("未生成可用因子，可换模型或提示后再试")
    } catch (e) {
      setError(errOf(e, "生成失败"))
    } finally {
      setGenLoading(false)
    }
  }

  async function handleBuildTask(): Promise<void> {
    if (!selected || !lastReq) return
    if (selected.metrics?.overfit_warning) {
      setError("该因子未通过样本外验证（测试段亏损），已禁止挂载实盘")
      return
    }
    if (lacksOosInfo(selected.metrics, lastReq.train_ratio)) {
      setError("该记录无样本外验证信息（旧口径历史），请重新搜索/回测后再挂载")
      return
    }
    if (selected.metrics?.stale_kernel) {
      setError("该记录为旧内核口径产出（指标与当前口径不一致），禁止直接挂载实盘；请重新回测确认")
      return
    }
    // 本地专属特征公式:服务端无法计算信号 → 创建后自动切本地引擎执行
    const localOnly = isLocalOnly(selected.tokens, selected.metrics)
    setBuilding(true)
    setBuildMsg(null)
    try {
      const task = await createTask(
        buildFactorTaskPayload(lastReq.symbol, lastReq.timeframe, selected.tokens),
      )
      if (localOnly) {
        await switchTaskSite(task.id, "client")
        setBuildMsg(`已创建并设为本地引擎执行：${task.name}（含本地专属特征，服务器无法计算；需应用保持运行）`)
      } else {
        setBuildMsg(`已创建：${task.name}（到 AI 交易页启动）`)
      }
    } catch (e) {
      setBuildMsg(errOf(e, "创建失败"))
    } finally {
      setBuilding(false)
    }
  }

  async function handleComboMount(chosen: Champion[]): Promise<void> {
    if (!lastReq) return
    if (chosen.length < 2 || chosen.length > 5) {
      setError("组合需勾选 2-5 个因子")
      return
    }
    const bad = chosen.find((c) => c.metrics?.overfit_warning || c.metrics?.stale_kernel)
    if (bad) {
      setError("组合成员含未通过样本外验证的因子（测试段亏损），已禁止挂载")
      return
    }
    // 任一成员含本地专属特征 → 整个组合只能本地引擎执行
    const localOnly = chosen.some((c) => isLocalOnly(c.tokens, c.metrics))
    setBuilding(true)
    setBuildMsg(null)
    try {
      const payload = buildComboTaskPayload(
        lastReq.symbol,
        lastReq.timeframe,
        chosen.map((c) => c.tokens),
      )
      const task = await createTask(payload)
      if (localOnly) {
        await switchTaskSite(task.id, "client")
        setBuildMsg(`已创建并设为本地引擎执行：${task.name}（含本地专属特征成员，服务器无法计算；需应用保持运行）`)
      } else {
        setBuildMsg(`已创建组合任务：${task.name}（到 AI 交易页启动）`)
      }
    } catch (e) {
      setBuildMsg(errOf(e, "创建失败"))
    } finally {
      setBuilding(false)
    }
  }

  async function favoriteFrom(
    item: FavoriteInput,
    opts?: { name?: string; folderId?: string | null },
  ): Promise<void> {
    if (item.metrics?.overfit_warning) {
      setError("该因子未通过样本外验证（测试段亏损），已禁止收藏")
      return
    }
    if (lacksOosInfo(item.metrics, lastReq?.train_ratio)) {
      setError("该记录无样本外验证信息（旧口径历史），请重新搜索/回测后再收藏")
      return
    }
    if (item.metrics?.stale_kernel) {
      setError("该记录为旧内核口径产出，请重新回测确认后再收藏")
      return
    }
    if (isLocalOnly(item.tokens, item.metrics)) {
      setError("该公式含本地专属特征，仅本机可执行，不支持收藏同步")
      return
    }
    // 默认名：品种中文名-年化收益:xx%
    const annRet = Number(item.metrics?.ann_ret ?? 0)
    const annPct = Number.isFinite(annRet) ? (annRet * 100).toFixed(1) : "0.0"
    const defaultName = `${contractNameOf(item.symbol)}-年化收益:${annPct}%`
    try {
      await addFactorFavorite({
        tokens: item.tokens,
        text: item.text,
        name: opts?.name?.trim() || defaultName,
        symbol: item.symbol,
        timeframe: item.timeframe,
        composite: item.composite,
        metrics: item.metrics,
        folder_id: opts?.folderId ?? null,
      })
      setBuildMsg(
        opts?.folderId ? "已收藏到指定文件夹" : "已加入收藏",
      )
      void refreshFavorites(symbol)
    } catch (e) {
      setError(errOf(e, "收藏失败"))
    }
  }

  /** 收藏弹窗用默认名（品种-年化收益） */
  function defaultFavoriteName(item: FavoriteInput): string {
    const annRet = Number(item.metrics?.ann_ret ?? 0)
    const annPct = Number.isFinite(annRet) ? (annRet * 100).toFixed(1) : "0.0"
    return `${contractNameOf(item.symbol)}-年化收益:${annPct}%`
  }

  async function handleFavoriteChampion(c: Champion): Promise<void> {
    await favoriteFrom({
      tokens: c.tokens,
      text: c.text,
      symbol: lastReq?.symbol ?? symbol,
      timeframe: lastReq?.timeframe ?? result?.timeframe ?? "",
      composite: c.composite,
      metrics: c.metrics,
    })
  }

  async function handleFavoriteHistory(item: FavoriteInput): Promise<void> {
    await favoriteFrom(item)
  }

  return {
    loading,
    btLoading,
    genLoading,
    result,
    selected,
    bt,
    error,
    lastReq,
    building,
    buildMsg,
    symbol,
    setSymbol,
    setBuildMsg,
    handleSearch,
    handleEvolve,
    engine,
    setEngine,
    progressNote,
    cancelLocalSearch,
    handleGenerate,
    selectFactor,
    handleBuildTask,
    handleComboMount,
    handleFavoriteChampion,
    handleFavoriteHistory,
    saveFavorite: favoriteFrom,
    defaultFavoriteName,
    deleteHistory: async (id: string) => {
      try {
        await deleteFactorHistory(id)
        void refreshHistory(symbol)
      } catch (e) {
        setError(errOf(e, "删除失败"))
      }
    },
    deleteFavorite: async (id: string) => {
      try {
        await deleteFactorFavorite(id)
        void refreshFavorites(symbol)
      } catch (e) {
        setError(errOf(e, "取消收藏失败"))
      }
    },
    ...data,
  }
}
