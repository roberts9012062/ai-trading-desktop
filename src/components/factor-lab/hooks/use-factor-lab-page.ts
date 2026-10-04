"use client"

/**
 * 因子实验室页面状态与操作
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { SearchFormPayload } from "../factor-search-form"
import {
  addFactorFavorite,
  backtestFactor,
  deleteFactorFavorite,
  deleteFactorHistory,
  llmGenerateFactors,
  type Champion,
  type FactorBacktestResult,
  type FactorMetrics,
  type SearchResult,
} from "@/lib/factor-lab-api"
import { createAITradingTask as createTask } from "@/lib/ai-trading-api"
import type { ProfitLockConfig } from "@/lib/ai-trading-api"
import { backtestFactorLocal, prepareSearchBars, type LocalSearchStep } from "@/lib/local-factor"
import { factorLabRunner, type FactorSearchTask } from "@/lib/mining/factor-lab-runner"
import { useFactorLabData } from "./use-factor-data"
import {
  buildFactorTaskPayload,
  defaultSearchPayload,
} from "./factor-helpers"

/** 本地引擎类型:本地 CPU(Pyodide) / 本地 GPU(WebGPU 粗排+内核精算)。
 *  服务端引擎已下线:类型保留 "server" 以兼容旧持久化值,读取时回退 cpu。 */
export type FactorEngine = "server" | "cpu" | "gpu" | "native-gpu"

function readEngine(): FactorEngine {
  if (typeof window === "undefined") return "cpu"
  try {
    const v = localStorage.getItem("qh_factor_engine")
    if (v === "cpu" || v === "gpu" || v === "native-gpu") return v
    // 旧值 "server"(含旧键迁移值)一律回退本地 CPU
  } catch {
    // 忽略存储异常
  }
  return "cpu"
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
  /** 页面级错误提示（组合挂载弹窗前置校验等） */
  setError: (s: string | null) => void
  handleSearch: (p: SearchFormPayload) => Promise<void>
  handleEvolve: () => Promise<void>
  /** 计算引擎三态与进度提示 */
  engine: FactorEngine
  setEngine: (v: FactorEngine) => void
  nativePrecision: "mixed" | "f64"
  setNativePrecision: (value: "mixed" | "f64") => void
  progressNote: string | null
  /** 本地挖掘结构化进度(与超级因子任务面板同款:代数/最优/并行度);非搜索期为 null */
  searchStep: LocalSearchStep | null
  /** 搜索累计耗时 ms(后台任务口径,切页回来仍准确) */
  searchElapsedMs: number
  /** 后台搜索任务(页面切走仍在跑;null=无任务) */
  bgTask: FactorSearchTask | null
  /** 搜索进行中(取数/计算) */
  searchActive: boolean
  /** 暂停/继续/停止(代边界生效) */
  pauseSearch: () => void
  resumeSearch: () => void
  stopSearch: () => void
  /** 取消本地搜索/回测(terminate 本地计算 worker;服务端请求无法客户端取消) */
  cancelLocalSearch: () => void
  handleGenerate: (payload: {
    model_row_id: string
    user_hint: string
  }) => Promise<void>
  selectFactor: (c: Champion, p?: SearchFormPayload) => Promise<void>
  handleBuildTask: (profitLock?: ProfitLockConfig) => Promise<void>
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

/** 已采纳过结果的搜索任务 id(模块级:切页回来不重复采纳) */
let lastAdoptedSearchId: string | null = null

/** 结果采纳时还原表单载荷:优先任务冻结的原文,缺失时按搜索载荷拼 */
function formOfPayload(
  p: NonNullable<FactorSearchTask["payload"]>,
  fallback: SearchFormPayload | null,
): SearchFormPayload {
  if (fallback) return fallback
  return {
    symbol: p.symbol,
    timeframe: p.timeframe,
    population: p.population,
    generations: p.generations,
    top_n: p.top_n,
    seed: p.seed,
    cost: p.cost ?? null,
    use_llm_coach: false,
    model_row_id: null,
    ...(p.train_ratio != null ? { train_ratio: p.train_ratio } : {}),
    ...(p.test_recent_bars != null ? { test_recent_bars: p.test_recent_bars } : {}),
    ...(p.walk_forward_folds != null ? { walk_forward_folds: p.walk_forward_folds } : {}),
    ...(p.selection_v2 ? { enhanced: true } : {}),
    ...(p.start_date && p.end_date ? { start_date: p.start_date, end_date: p.end_date } : {}),
    ...(p.data_channel ? { data_channel: p.data_channel } : {}),
  }
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
  const [nativePrecision, setNativePrecisionState] = useState<"mixed" | "f64">(() => {
    try { return localStorage.getItem("qh_native_precision") === "f64" ? "f64" : "mixed" } catch { return "mixed" }
  })
  const setNativePrecision = useCallback((value: "mixed" | "f64") => {
    setNativePrecisionState(value)
    try { localStorage.setItem("qh_native_precision", value) } catch { /* Preference storage is optional. */ }
  }, [])
  const [progressNote, setProgressNote] = useState<string | null>(null)
  // 后台搜索任务:module 级 runner 驱动,页面切走/回来搜索不断
  const [bgTask, setBgTask] = useState<FactorSearchTask | null>(factorLabRunner.current)
  useEffect(() => factorLabRunner.subscribe(setBgTask), [])
  const searchActive = bgTask != null && (bgTask.status === "running" || bgTask.status === "fetching")
  const searchStep: LocalSearchStep | null = bgTask?.lastStep ?? null
  const searchElapsedMs = bgTask?.elapsedMs ?? 0
  const pauseSearch = useCallback(() => factorLabRunner.pause(), [])
  const resumeSearch = useCallback(() => void factorLabRunner.resume(), [])
  const stopSearch = useCallback(() => factorLabRunner.stop(), [])
  // 任务状态 → 既有 UI 状态;完成时把结果采纳进页面(一次)
  useEffect(() => {
    if (!bgTask) return
    const st = bgTask.status
    setProgressNote(
      st === "completed" || st === "cancelled" || st === "failed" ? null : bgTask.phase,
    )
    setLoading(st === "running" || st === "fetching")
    if (st === "failed" && bgTask.error) setError(bgTask.error)
    if (st === "completed" && bgTask.result && lastAdoptedSearchId !== bgTask.id) {
      lastAdoptedSearchId = bgTask.id
      void applySearchResult(bgTask.result, formOfPayload(bgTask.payload, bgTask.form))
    }
  }, [bgTask])
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
    if (factorLabRunner.current?.nativeRequested) { factorLabRunner.stop(); return }
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
        if (engine === "server" && c.metrics.research_only) throw new Error("该因子依赖本地直连数据，请切换本地 CPU/GPU 回测")
        // 本地引擎:单因子回测也在本机计算(与搜索同一份 K 线)
        if (engine !== "server") {
          res = await backtestFactorLocal(
            {
              symbol: sym,
              timeframe: tf,
              factor_tokens: c.tokens,
              crypto_profile: c.metrics.crypto_profile ?? false,
              cost: c.metrics.cost ?? p?.cost ?? lastReq?.cost,
              data_channel: c.metrics.data_channel ?? p?.data_channel ?? lastReq?.data_channel,
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

  async function handleSearch(p: SearchFormPayload): Promise<void> {
    setError(null)
    setProgressNote(null)
    setResult(null)
    setSelected(null)
    setBt(null)
    setLastReq(p)
    setSymbol(p.symbol)
    if (p.data_channel === "gate_usdt" && p.use_llm_coach) {
      setError("Gate 永续直连仅支持本地 CPU/GPU 搜索，请关闭服务端教练")
      return
    }
    // 服务端引擎已下线:一律本地计算(CPU/GPU,engine 读取时已回退)。
    // LLM 教练依赖服务端搜索,入口已隐藏;此处再兜底忽略误传的 coach 标记
    if (p.use_llm_coach) {
      p = { ...p, use_llm_coach: false }
    }
    // 后台 runner 接管全生命周期:切页不断,暂停/停止落在代边界,
    // 完成时经订阅流采纳结果并落历史(runner 内 best-effort)
    if (!factorLabRunner.canStart()) {
      setError("已有搜索在后台运行，请先暂停或停止后再发起新搜索")
      return
    }
    setLoading(true)
    try {
      await factorLabRunner.start(
        {
          symbol: p.symbol,
          ...(engine === "native-gpu" ? { native_precision: nativePrecision } : {}),
          data_channel: p.data_channel,
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
          ...(p.combo_super ? { combo_super: true } : {}),
          ...(p.seed_tokens?.length ? { seed_tokens: p.seed_tokens } : {}),
          ...(p.start_date && p.end_date ? { start_date: p.start_date, end_date: p.end_date } : {}),
        },
        engine === "native-gpu" ? "native-gpu" : engine === "gpu" ? "gpu" : "cpu",
        p,
      )
    } catch (e) {
      setError(errOf(e, "搜索启动失败"))
      setLoading(false)
    }
  }

  async function handleEvolve(): Promise<void> {
    if (!lastReq || !result?.champions.length) return
    const seeds = result.champions.slice(0, 5).map((c) => c.tokens)
    const p = { ...lastReq }
    setError(null)
    setProgressNote(null)
    try {
      if (p.data_channel === "gate_usdt" && (engine === "server" || p.use_llm_coach)) throw new Error("Gate 永续直连仅支持本地 CPU/GPU 搜索")
      // 本地引擎再进化:种子 token 直接透传,seed+1(同样走后台 runner)
      if (engine !== "server" && !p.use_llm_coach) {
        if (!factorLabRunner.canStart()) {
          setError("已有搜索在后台运行，请先暂停或停止后再进化")
          return
        }
        setLoading(true)
        await factorLabRunner.start(
          {
            symbol: p.symbol,
            ...(engine === "native-gpu" ? { native_precision: nativePrecision } : {}),
            data_channel: p.data_channel,
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
          ...(p.combo_super ? { combo_super: true } : {}),
            ...(p.start_date && p.end_date ? { start_date: p.start_date, end_date: p.end_date } : {}),
          },
          engine === "native-gpu" ? "native-gpu" : engine === "gpu" ? "gpu" : "cpu",
          { ...p, seed: p.seed + 1 },
        )
        return
      }
    } catch (e) {
      setError(errOf(e, "进化失败"))
      setLoading(false)
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

  async function handleBuildTask(profitLock?: ProfitLockConfig): Promise<void> {
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
    setBuilding(true)
    setBuildMsg(null)
    try {
      const payload = buildFactorTaskPayload(lastReq.symbol, lastReq.timeframe, selected.tokens)
      if (profitLock) payload.close_rules = { ...payload.close_rules!, profit_lock: { ...profitLock } }
      const task = await createTask(payload)
      setBuildMsg(`已创建服务器任务：${task.name}（到 AI 交易页启动，关闭桌面端后继续运行）`)
    } catch (e) {
      setBuildMsg(errOf(e, "创建失败"))
    } finally {
      setBuilding(false)
    }
  }

  /** 旧口径记录的本地复测:单候选 mine_precise 与搜索同口径,
   *  产出 test_metrics/overfit_warning;失败返回 null */
  async function reverifyOosMetrics(item: FavoriteInput): Promise<FavoriteInput | null> {
    const sym = (item.symbol || lastReq?.symbol || symbol).trim().toLowerCase()
    const tf = item.timeframe || lastReq?.timeframe || "1d"
    const channel = (item.metrics as Partial<FactorMetrics> & { data_channel?: string }).data_channel
      ?? lastReq?.data_channel
    try {
      setProgressNote("该记录缺样本外信息，本地复测验证中（复用缓存，通常数秒）…")
      const bars = await prepareSearchBars({
        symbol: sym,
        timeframe: tf,
        population: 1,
        generations: 1,
        top_n: 1,
        seed: 42,
        cost: null,
        ...(channel ? { data_channel: channel } : {}),
        ...(lastReq?.train_ratio != null ? { train_ratio: lastReq.train_ratio } : { train_ratio: 0.7 }),
        ...(lastReq?.walk_forward_folds != null ? { walk_forward_folds: lastReq.walk_forward_folds } : { walk_forward_folds: 3 }),
      }, setProgressNote)
      const { ensurePyWorker } = await import("@/lib/py-worker")
      const res = (await ensurePyWorker().factorRun(
        {
          mode: "mine_precise",
          symbol: sym,
          timeframe: tf,
          crypto_profile: (item.metrics.crypto_profile ?? true) as boolean,
          population: 1,
          generations: 1,
          max_depth: 4,
          train_ratio: lastReq?.train_ratio ?? 0.7,
          walk_forward_folds: lastReq?.walk_forward_folds ?? 3,
          top_n: 1,
          cost: item.metrics.cost ?? null,
          candidates: [item.tokens],
          best_seen: [],
          trials: 1,
          final_generation: true,
        },
        bars,
        120_000,
      )) as { champions?: Array<{ tokens: number[]; composite: number; metrics: Record<string, unknown> }> }
      const champ = res?.champions?.find((c) => c.tokens.join(",") === item.tokens.join(",")) ?? res?.champions?.[0]
      if (!champ || (!champ.metrics?.test_metrics && !champ.metrics?.overfit_warning)) return null
      return {
        ...item,
        composite: Number(champ.composite ?? item.composite),
        metrics: { ...item.metrics, ...champ.metrics } as FavoriteInput["metrics"],
      }
    } catch {
      return null
    } finally {
      setProgressNote(null)
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
      // 桌面端兜底:旧口径历史(或服务端历史往返丢失样本外字段)不再硬拦,
      // 本地单候选 mine_precise 复测补齐 test_metrics/overfit_warning 后
      // 继续收藏——测试段亏损会自然落入 overfit_warning 拦截,防线不弱化
      const reverified = await reverifyOosMetrics(item)
      if (!reverified) {
        setError("该记录无法完成本地样本外复测（数据不可得），请重新搜索后再收藏")
        return
      }
      item = reverified
    }
    if (item.metrics?.stale_kernel) {
      setError("该记录为旧内核口径产出，请重新回测确认后再收藏")
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
    setError,
    handleSearch,
    handleEvolve,
    engine,
    nativePrecision,
    setNativePrecision,
    setEngine,
    progressNote,
    searchStep,
    searchElapsedMs,
    bgTask,
    searchActive,
    pauseSearch,
    resumeSearch,
    stopSearch,
    cancelLocalSearch,
    handleGenerate,
    selectFactor,
    handleBuildTask,
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
