"use client"

/**
 * 短线因子实验室 v2 —— 简化流程与现代化界面
 *
 * 核心优化：
 * - 一键启动：自动回填 → 挖掘 → 展示冠军
 * - 简化表单：只保留核心参数（币种/周期/算力）
 * - 实时进度：统一进度条 + 状态卡片
 * - 现代界面：卡片式布局，减少视觉噪音
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRunner } from "@/lib/mining/runner"
import type { MiningTask } from "@/lib/mining/types"
import { addFactorFavorite } from "@/lib/factor-lab-api"
import {
  digestUsage, runBackfillWithStore, missingRange, listDayDigests, loadDigestRange,
} from "@/lib/shortline/backfill/pipeline"
import {
  SHORTLINE_SYMBOLS, TIMEFRAME_BACKFILL_DAYS, DEFAULT_SHORTLINE_SYMBOL,
  SHORTLINE_TIMEFRAMES, type CadenceSeconds, type ShortlineTimeframe,
} from "@/lib/shortline/spec"
import { buildShortlinePayload, checkMountable, requiredWarmupBars } from "@/lib/shortline/mount"
import { buildGoldenCase, buildFixtureBundle } from "@/lib/shortline/fixtures"
import { createShortlineTask, listShortlineTasks, type ShortlineServerTask } from "@/lib/shortline/server-api"

const runner = createRunner("local")

interface ChampionLite {
  tokens: number[]
  text?: string
  composite: number
  metrics: Record<string, unknown>
}

function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${(n / 1e3).toFixed(0)} KB`
}

function fmtNum(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "—"
}

/** 资格拒因的如实中文解释(引擎 qualification.py 的 reasons) */
const REJECT_REASON_LABELS: Record<string, string> = {
  holdout_failed_or_missing: "封存段（最终样本外）收益为负或缺失",
  holdout_stress_failed_or_missing: "封存段 2× 成本压力测试未通过",
  holdout_live_entry_failed: "封存段实盘离散入场未通过",
  holdout_sealed: "封存段未解封（非末代）",
  oos_validation_failed_or_missing: "验证段样本外收益为负",
  oos_validation_unavailable: "验证段不可用（数据不足）",
  wf_failed_or_missing: "Walk-Forward 稳健性未通过",
  wf_oos_fold_failed: "Walk-Forward 样本外折亏损",
  wf_oos_evidence_missing: "样本外折证据缺失",
  strict_screen_failed_or_unproven: "严格筛（符号稳定性）未通过",
  research_only_candidate: "仅供研究（过拟合警示）",
  insufficient_samples: "样本不足",
  nonfinite_metric: "指标异常（非有限值）",
  live_fill_failed_or_missing: "实盘成交模拟未通过",
  execution_failed_or_missing: "执行成本口径未通过",
}

type Stage = "idle" | "backfill" | "mining" | "completed" | "failed" | "paused"

export default function ShortlineLabPageV2() {
  // ── 核心参数（简化：只保留必需项） ──
  const [symbol, setSymbol] = useState(DEFAULT_SHORTLINE_SYMBOL)
  const [timeframe, setTimeframe] = useState<ShortlineTimeframe>("15m")
  const [engine, setEngine] = useState<"native-gpu" | "cpu">("native-gpu")

  // ── 高级参数（默认值 + 用户可调） ──
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [population, setPopulation] = useState(600)
  const [generations, setGenerations] = useState(40)
  const [maxDepth, setMaxDepth] = useState(5)
  const [trainRatio, setTrainRatio] = useState(0.7)
  const [walkForwardFolds, setWalkForwardFolds] = useState(3)
  const [cost, setCost] = useState(0.0003)

  // ── 统一状态机 ──
  const [stage, setStage] = useState<Stage>("idle")
  const [progress, setProgress] = useState(0)
  const [statusMsg, setStatusMsg] = useState("")
  const [error, setError] = useState<string | null>(null)

  // ── 数据状态 ──
  const [usage, setUsage] = useState<{ days: number, bytes: number }>({ days: 0, bytes: 0 })
  const [champions, setChampions] = useState<ChampionLite[]>([])
  const [activeTask, setActiveTask] = useState<MiningTask | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  // ── 收藏与挂载（服务器短线任务系统，契约 shortline_factor_v1） ──
  const [favMsgs, setFavMsgs] = useState<Record<string, string>>({})
  const [favBusy, setFavBusy] = useState<string | null>(null)
  const [cadence, setCadence] = useState<CadenceSeconds>(15)
  const [mountMsg, setMountMsg] = useState<string | null>(null)
  const [mounting, setMounting] = useState(false)
  const [serverTasks, setServerTasks] = useState<ShortlineServerTask[] | null>(null)
  const [serverTaskErr, setServerTaskErr] = useState<string | null>(null)

  // ── 建议区间 ──
  const suggestedFrom = useMemo(() => {
    const days = TIMEFRAME_BACKFILL_DAYS[timeframe]
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  }, [timeframe])
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // ── 刷新数据统计 ──
  const refreshUsage = useCallback(async (sym: string) => {
    setUsage(await digestUsage(sym))
  }, [])
  useEffect(() => { void refreshUsage(symbol) }, [refreshUsage, symbol])

  // ── 刷新任务与冠军 ──
  const refreshTasks = useCallback(async () => {
    const all = await runner.list()
    const mine = all.filter((t) => t.config?.research_profile === "shortline_v1")
    const byNewest = (a: MiningTask, b: MiningTask) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? "")
    const active = mine.find((t) => t.status === "running" || t.status === "pending")
    // 焦点任务:优先运行/排队中;否则盯最近创建的一个。任务完成后不再是"活跃",
    // 但阶段流转要靠它的终态(completed/failed)驱动,否则永远停在"挖掘中"
    const focus = active ?? [...mine].sort(byNewest)[0] ?? null
    setActiveTask(focus)

    const champTask = active ?? mine.filter((t) => t.status === "completed").sort(byNewest)[0]
    if (champTask?.id) {
      const rows = await runner.champions(champTask.id)
      setChampions(rows.map((c) => ({
        tokens: c.tokens, text: c.text, composite: c.composite,
        metrics: c.metrics as unknown as Record<string, unknown>,
      })))
    }
  }, [])

  useEffect(() => {
    void refreshTasks()
    const unsub = runner.subscribe(() => void refreshTasks())
    return () => { unsub?.() }
  }, [refreshTasks])

  // ── 一键启动完整流程 ──
  const onStartMining = async () => {
    if (stage !== "idle") return
    abortRef.current = new AbortController()
    setError(null)

    try {
      // 阶段 1：回填数据
      setStage("backfill")
      setProgress(0)
      setStatusMsg(`准备回填 ${symbol} 数据...`)

      const days = (await listDayDigests(symbol)).map((d) => d.day)
      const mr = missingRange(suggestedFrom, today, days)

      if (mr.from && mr.to) {
        setStatusMsg(`回填 ${symbol} 中（${mr.from} → ${mr.to}）...`)
        await runBackfillWithStore({
          symbol,
          fromDay: mr.from,
          toDay: mr.to,
          signal: abortRef.current.signal,
          onProgress: (p) => {
            setProgress(Math.round((p.index / p.total) * 40))
            setStatusMsg(`回填 ${p.day} · ${fmtBytes(p.cumulativeBytes)}`)
          },
        })
        await refreshUsage(symbol)
      }

      // 阶段 2：启动挖掘
      setStage("mining")
      setProgress(40)
      setStatusMsg("创建挖掘任务...")

      const task = await runner.create(
        {
          symbol,
          timeframe,
          population,
          generations,
          max_depth: maxDepth,
          train_ratio: trainRatio,
          walk_forward_folds: walkForwardFolds,
          selection_v2: true,
          evolve_v2: true,
          research_profile: "shortline_v1",
          cost,
          native_precision: "mixed",
          data_channel: "binance_usdt",
        },
        {
          device: engine,
          name: `短线·${symbol}·${timeframe}`,
          onProgress: (m) => {
            setStatusMsg(m)
            setProgress(40 + Math.random() * 10)
          },
        },
      )

      setStatusMsg(`挖掘中：${task.name}`)
      await refreshTasks()

      // 阶段 3：等待完成（由订阅更新）
      setProgress(50)

    } catch (e) {
      setStage("failed")
      setError(e instanceof Error ? e.message : String(e))
      setStatusMsg("启动失败")
    }
  }

  // ── 监听焦点任务,驱动阶段流转 ──
  useEffect(() => {
    if (!activeTask) return

    if (activeTask.status === "completed") {
      setStage("completed")
      setProgress(100)
      const researchN = activeTask.research_champions?.length ?? 0
      setStatusMsg(`完成：发现 ${champions.length} 个冠军` + (researchN ? ` · ${researchN} 个研究级` : ""))
    } else if (activeTask.status === "failed") {
      setStage("failed")
      setError(activeTask.error_msg ?? "任务失败")
    } else if (activeTask.status === "paused") {
      setStage("paused")
      setStatusMsg(activeTask.pause_reason ?? "任务已暂停")
    } else if (activeTask.status === "pending") {
      setStage("mining")
      setProgress(50)
      setStatusMsg(`任务排队中（等待算力释放）...`)
    } else if (activeTask.status === "running") {
      setStage("mining")
      if (activeTask.nativePhase) {
        // 原生引擎冷启动/自检期:current_generation 还是 0,显示引擎自报的阶段
        // 消息(f64 首次编译 3-6 分钟,不能让用户面对静默)
        setStatusMsg(activeTask.nativePhase)
        return
      }
      const genProgress = activeTask.current_generation && activeTask.generations
        ? (activeTask.current_generation / activeTask.generations) * 100
        : 0
      setProgress(50 + genProgress / 2)
      setStatusMsg(
        `第 ${activeTask.current_generation ?? 0}/${activeTask.generations ?? 0} 代 · ` +
        `适应度评估中 · ${genProgress.toFixed(1)}% 完成`
      )
    }
  }, [activeTask?.id, activeTask?.status, activeTask?.current_generation, activeTask?.generations, activeTask?.nativePhase, activeTask?.research_champions?.length, champions.length])

  // ── 收藏冠军到因子库（服务器收藏，同主实验室口径） ──
  const onFavorite = async (c: { tokens: number[]; text?: string; composite: number }) => {
    const key = c.tokens.join(",")
    setFavBusy(key)
    try {
      await addFactorFavorite({
        tokens: c.tokens,
        text: c.text ?? c.tokens.join(" "),
        symbol,
        timeframe,
        composite: c.composite,
        note: "短线因子实验室",
      })
      setFavMsgs((m) => ({ ...m, [key]: "已收藏到因子库" }))
    } catch (e) {
      setFavMsgs((m) => ({
        ...m,
        [key]: `收藏失败：${e instanceof Error ? e.message : String(e)}`,
      }))
    } finally {
      setFavBusy(null)
    }
  }
  const favButton = (c: { tokens: number[]; text?: string; composite: number }) => {
    const key = c.tokens.join(",")
    const msg = favMsgs[key]
    return (
      <button
        onClick={() => void onFavorite(c)}
        disabled={favBusy === key || msg === "已收藏到因子库"}
        className="text-xs px-3 py-1 rounded-lg border border-[#38BDF8]/40 text-[#38BDF8]
                 hover:bg-[#38BDF8]/10 transition-colors disabled:opacity-60 whitespace-nowrap"
        title={msg && msg !== "已收藏到因子库" ? msg : "收藏到服务器因子库"}
      >
        {favBusy === key ? "收藏中…" : msg === "已收藏到因子库" ? "✓ 已收藏" : "收藏"}
      </button>
    )
  }

  // ── 挂载（服务器短线任务系统，契约 shortline_factor_v1；纸面模式） ──
  const mountPool = useMemo(() => {
    const exec = champions.slice(0, 8).map((c, i) => ({ id: i + 1, tokens: c.tokens }))
    if (exec.length) return exec
    // 无执行级冠军时允许挂研究级(样本外 1× 盈利;风险自担)
    return (activeTask?.research_champions ?? []).slice(0, 8)
      .map((c, i) => ({ id: i + 1, tokens: c.tokens }))
  }, [champions, activeTask?.research_champions])
  const mountCheck = useMemo(
    () => (mountPool.length ? checkMountable(mountPool.map((c) => c.tokens)) : { ok: false, reasons: ["无冠军"], localOnlyTokens: [] }),
    [mountPool],
  )
  const warmupBars = useMemo(
    () => (mountPool.length ? requiredWarmupBars(mountPool.map((c) => c.tokens), timeframe) : 300),
    [mountPool, timeframe],
  )
  const usingResearchPool = champions.length === 0 && (activeTask?.research_champions?.length ?? 0) > 0

  const onMount = async () => {
    setMounting(true)
    setMountMsg("导出黄金夹具并组装载荷…")
    try {
      const days = (await listDayDigests(symbol)).map((d) => d.day)
      if (!days.length) throw new Error("无 digest——请先回填 aggTrades")
      const last = days[days.length - 1]!
      const loaded = await loadDigestRange(symbol, last, last)
      if (!loaded) throw new Error("digest 载入失败")
      const formulas = mountPool.map((c) => c.tokens)
      const cases = [3, 15, 60].map((cad) => buildGoldenCase({
        name: `${symbol}-${timeframe}-${cad}s-${last}`,
        symbol, timeframe, cadence: cad as CadenceSeconds,
        buckets: loaded.buckets, formulas,
      }))
      const bundle = buildFixtureBundle(symbol, cases, formulas)
      const payload = buildShortlinePayload(
        { symbol, timeframe, cadence, champions: mountPool, warmupBars },
        bundle.manifest.manifest_sha256,
      )
      const task = await createShortlineTask(payload, `短线·${symbol}·${timeframe}·${cadence}s`)
      setMountMsg(`挂载成功：服务器任务 ${task.id}（${task.status ?? "created"}，纸面模式）`)
      await refreshServerTasks()
    } catch (e) {
      setMountMsg(`挂载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMounting(false)
    }
  }

  const refreshServerTasks = useCallback(async () => {
    setServerTaskErr(null)
    try {
      setServerTasks(await listShortlineTasks())
    } catch (e) {
      setServerTasks(null)
      setServerTaskErr(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => {
    if (stage === "completed") void refreshServerTasks()
  }, [stage, refreshServerTasks])

  // ── 停止 ──
  const onStop = () => {
    abortRef.current?.abort()
    const busy = activeTask?.status === "running" || activeTask?.status === "pending"
    if (activeTask?.id && busy) runner.cancel(activeTask.id)
    setStage("idle")
    setProgress(0)
    setStatusMsg("")
  }

  // ── 重置 ──
  const onReset = () => {
    setStage("idle")
    setProgress(0)
    setStatusMsg("")
    setError(null)
  }

  const taskBusy = activeTask?.status === "running" || activeTask?.status === "pending"
  const canStart = stage === "idle" && !taskBusy

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0A0D12] via-[#0F131C] to-[#161D2B] p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* 标题区 */}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-white">短线因子实验室</h1>
          <p className="text-sm text-gray-400">
            1m/5m/15m 高频因子挖掘 · v4 订单流特征 · 一键启动
          </p>
        </div>

        {/* 参数卡片 */}
        <div className="bg-[#1E2636]/50 backdrop-blur-sm rounded-2xl border border-white/5 p-6 space-y-4">
          <h2 className="text-sm font-medium text-gray-300">配置参数</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* 币种 */}
            <div className="space-y-2">
              <label className="text-xs text-gray-400">币种</label>
              <input
                list="shortline-symbol-options"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                disabled={stage !== "idle"}
                className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                         placeholder:text-gray-500 focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                placeholder="ETHUSDT"
              />
              <datalist id="shortline-symbol-options">
                {SHORTLINE_SYMBOLS.map((sym) => <option key={sym} value={sym} />)}
              </datalist>
            </div>

            {/* 周期 */}
            <div className="space-y-2">
              <label className="text-xs text-gray-400">周期</label>
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as ShortlineTimeframe)}
                disabled={stage !== "idle"}
                className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                         focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
              >
                {SHORTLINE_TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
            </div>

            {/* 算力 */}
            <div className="space-y-2">
              <label className="text-xs text-gray-400">算力</label>
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as "native-gpu" | "cpu")}
                disabled={stage !== "idle"}
                className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                         focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
              >
                <option value="native-gpu">原生 GPU（推荐）</option>
                <option value="cpu">CPU 多核</option>
              </select>
            </div>
          </div>

          {/* 数据统计 */}
          <div className="flex items-center justify-between pt-2 border-t border-white/5">
            <span className="text-xs text-gray-500">
              已缓存 {usage.days} 天 · {fmtBytes(usage.bytes)}
            </span>
            <span className="text-xs text-gray-500">
              建议区间：{TIMEFRAME_BACKFILL_DAYS[timeframe]} 天
            </span>
          </div>

          {/* 高级参数（可折叠） */}
          <div className="pt-4 border-t border-white/5">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              disabled={stage !== "idle"}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors disabled:opacity-50"
            >
              <span className={`transform transition-transform ${showAdvanced ? "rotate-90" : ""}`}>▶</span>
              高级参数设置
            </button>

            {showAdvanced && (
              <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4">
                {/* 种群规模 */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400 flex items-center justify-between">
                    <span>种群规模</span>
                    <span className="text-gray-600">max 30000</span>
                  </label>
                  <input
                    type="number"
                    min={50}
                    max={30000}
                    step={50}
                    value={population}
                    onChange={(e) => setPopulation(Math.min(30000, Math.max(50, Number(e.target.value))))}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                             focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-600">默认 600，影响搜索广度</p>
                </div>

                {/* 进化代数 */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400 flex items-center justify-between">
                    <span>进化代数</span>
                    <span className="text-gray-600">max 3000</span>
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={3000}
                    step={10}
                    value={generations}
                    onChange={(e) => setGenerations(Math.min(3000, Math.max(10, Number(e.target.value))))}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                             focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-600">默认 40，更多代数=更深搜索</p>
                </div>

                {/* 单位换手成本 */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400 flex items-center justify-between">
                    <span>单位换手成本</span>
                    <span className="text-gray-600">0.5-10 bp</span>
                  </label>
                  <input
                    type="number"
                    min={0.00005}
                    max={0.001}
                    step={0.00005}
                    value={cost}
                    onChange={(e) => setCost(Math.min(0.001, Math.max(0.00005, Number(e.target.value))))}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white font-mono
                             focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-600 leading-relaxed">
                    默认 0.0003（3bp）。资格门会以 2× 成本做压力测试——若你的真实执行
                    成本更低（纯 maker），如实调低可提高冠军产出；请勿为凑冠军虚标。
                  </p>
                </div>

                {/* 最大深度 */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400 flex items-center justify-between">
                    <span>公式最大深度</span>
                    <span className="text-gray-600">3-8</span>
                  </label>
                  <input
                    type="number"
                    min={3}
                    max={8}
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(Math.min(8, Math.max(3, Number(e.target.value))))}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                             focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-600">默认 5，深度过大易过拟合</p>
                </div>

                {/* 训练集比例 */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400">训练集比例</label>
                  <input
                    type="number"
                    min={0.5}
                    max={0.8}
                    step={0.05}
                    value={trainRatio}
                    onChange={(e) => setTrainRatio(Math.min(0.8, Math.max(0.5, Number(e.target.value))))}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                             focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-600">默认 0.7（70%训练/30%验证）</p>
                </div>

                {/* Walk-Forward 折数 */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400">WF 验证折数</label>
                  <input
                    type="number"
                    min={2}
                    max={5}
                    value={walkForwardFolds}
                    onChange={(e) => setWalkForwardFolds(Math.min(5, Math.max(2, Number(e.target.value))))}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl border border-white/10 bg-[#0F131C] px-4 py-2.5 text-sm text-white
                             focus:border-[#38BDF8] focus:outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-600">默认 3，防过拟合关键参数</p>
                </div>

                {/* 重置按钮 */}
                <div className="flex items-end">
                  <button
                    onClick={() => {
                      setPopulation(600)
                      setGenerations(40)
                      setMaxDepth(5)
                      setTrainRatio(0.7)
                      setWalkForwardFolds(3)
                      setCost(0.0003)
                    }}
                    disabled={stage !== "idle"}
                    className="w-full rounded-xl bg-[#0F131C]/50 border border-white/10 px-4 py-2.5 text-sm text-gray-400
                             hover:text-gray-300 hover:border-white/20 transition-colors disabled:opacity-50"
                  >
                    恢复默认值
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 进度卡片 */}
        {stage !== "idle" && (
          <div className="bg-[#1E2636]/50 backdrop-blur-sm rounded-2xl border border-white/5 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">
                {stage === "backfill" && "回填数据"}
                {stage === "mining" && "挖掘因子"}
                {stage === "completed" && "✓ 完成"}
                {stage === "failed" && "✗ 失败"}
                {stage === "paused" && "⏸ 已暂停"}
              </h2>
              {(stage === "backfill" || stage === "mining") && (
                <button
                  onClick={onStop}
                  className="text-xs text-red-400 hover:text-red-300 px-3 py-1 rounded-lg border border-red-500/30"
                >
                  停止
                </button>
              )}
              {(stage === "completed" || stage === "failed" || stage === "paused") && (
                <button
                  onClick={onReset}
                  className="text-xs text-gray-400 hover:text-gray-300 px-3 py-1 rounded-lg border border-white/10"
                >
                  重置
                </button>
              )}
            </div>

            {/* 进度条 */}
            <div className="space-y-2">
              <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#38BDF8] to-[#6EE7B7] transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">{statusMsg}</p>
                <span className="text-xs text-gray-500 font-mono">{progress.toFixed(1)}%</span>
              </div>
            </div>

            {/* 挖掘阶段详细信息 */}
            {stage === "mining" && activeTask?.status === "running" && (
              <div className="rounded-xl bg-[#0F131C]/50 border border-white/5 p-4 space-y-3">
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-gray-500">当前代数</span>
                    <p className="text-white font-mono text-base">
                      {activeTask.current_generation ?? 0} / {activeTask.generations ?? 0}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-500">种群规模</span>
                    <p className="text-white font-mono text-base">{population}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">最大深度</span>
                    <p className="text-white font-mono text-base">{maxDepth}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">WF 折数</span>
                    <p className="text-white font-mono text-base">{walkForwardFolds}</p>
                  </div>
                </div>

                {/* 实时状态指示器 */}
                <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full animate-pulse ${activeTask.nativePhase ? "bg-[#F59E0B]" : "bg-[#6EE7B7]"}`} />
                    <span className="text-xs text-gray-400">
                      {activeTask.nativePhase ? "引擎启动/自检中..." : "正在进化中..."}
                    </span>
                  </div>
                  {!activeTask.nativePhase && (activeTask.current_generation ?? 0) > 0 && (
                    <span className="text-xs text-gray-600 ml-auto">
                      预计剩余: {(() => {
                        const remaining = (activeTask.generations ?? 0) - (activeTask.current_generation ?? 0)
                        const timePerGen = 3 // 预估每代 3 秒
                        const mins = Math.ceil(remaining * timePerGen / 60)
                        return `~${mins} 分钟`
                      })()}
                    </span>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3">
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}

            {/* 完成 but 0 冠军:如实展示资格门的否决原因,而不是静默的零 */}
            {stage === "completed" && champions.length === 0 && (activeTask?.qualificationReasons?.length ?? 0) > 0 && (
              <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-4 space-y-2">
                <p className="text-xs text-amber-300 font-medium">
                  {(activeTask?.research_champions?.length ?? 0) > 0
                    ? "执行级冠军 0 个，但有研究级产出（见下方列表）——样本外已盈利，差在成本压力"
                    : "挖掘完成，但决赛候选无一通过资格门——这是如实否决，不是故障"}
                </p>
                {activeTask?.qualificationCounts && (
                  <p className="text-xs text-gray-400">
                    决赛候选 {activeTask.qualificationCounts.qualified + activeTask.qualificationCounts.rejected + activeTask.qualificationCounts.pending} 个：
                    {activeTask.qualificationCounts.qualified} 合格 · {activeTask.qualificationCounts.rejected} 被拒 · {activeTask.qualificationCounts.pending} 待定
                  </p>
                )}
                <ul className="text-xs text-gray-400 list-disc list-inside space-y-1">
                  {activeTask?.qualificationReasons?.map((r) => (
                    <li key={r}>{REJECT_REASON_LABELS[r] ?? r}</li>
                  ))}
                </ul>
                <p className="text-xs text-gray-500 leading-relaxed">
                  封存段是最终样本外考试（训练全程不可见）。常见原因：训练期与封存段行情反转、
                  换手成本吞噬边际、或搜索预算不足。可尝试：更长回填区间、更大种群/代数后重跑。
                </p>
              </div>
            )}
          </div>
        )}

        {/* 冠军卡片 */}
        {champions.length > 0 && (
          <div className="bg-[#1E2636]/50 backdrop-blur-sm rounded-2xl border border-white/5 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">
                冠军因子 · {champions.length} 个
              </h2>
              {stage === "completed" && (
                <span className="text-xs text-emerald-400">✓ 已验证</span>
              )}
            </div>

            <div className="space-y-2">
              {champions.slice(0, 10).map((c, i) => (
                <div
                  key={i}
                  className="rounded-xl bg-[#0F131C]/50 border border-white/5 p-4 space-y-2
                           hover:border-white/10 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-gray-400">#{i + 1}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[#38BDF8]">
                        {c.composite.toFixed(3)}
                      </span>
                      {favButton(c)}
                    </div>
                  </div>
                  <p className="text-xs text-gray-300 truncate font-mono">
                    {c.text ?? c.tokens.join(" ")}
                  </p>
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <div>
                      <span className="text-gray-500">翻转率</span>
                      <p className="text-white">{fmtNum(c.metrics.flip_rate)}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">半衰期</span>
                      <p className="text-white">{fmtNum(c.metrics.half_life)}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">换手</span>
                      <p className="text-white">{fmtNum(c.metrics.avg_turnover)}</p>
                    </div>
                    <div>
                      <span className="text-gray-500">IC</span>
                      <p className="text-white">{fmtNum(c.metrics.ts_ic)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 研究级冠军卡片:样本外 1× 已盈利,仅未扛住 2× 成本压力 */}
        {(activeTask?.research_champions?.length ?? 0) > 0 && (
          <div className="bg-[#1E2636]/50 backdrop-blur-sm rounded-2xl border border-amber-500/20 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-amber-300">
                研究级冠军 · {activeTask?.research_champions?.length ?? 0} 个
              </h2>
              <span className="text-xs text-gray-500">样本外盈利 · 未扛住 2× 成本压力</span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              以下因子的严格筛/Walk-Forward/验证段/封存段(1× 成本)全部通过，
              唯独在加倍成本压力下转负——按执行级标准不算合格冠军。若你的真实
              执行成本显著低于当前设置，可在高级参数里如实调低后复跑。
            </p>
            <div className="space-y-2">
              {activeTask?.research_champions?.slice(0, 10).map((c, i) => {
                const holdout = (c.metrics as { holdout_metrics?: { sortino?: number, sortino_2x?: number } })
                  ?.holdout_metrics
                return (
                  <div
                    key={i}
                    className="rounded-xl bg-[#0F131C]/50 border border-amber-500/10 p-4 space-y-2
                             hover:border-amber-500/20 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-gray-400">R#{i + 1}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-amber-300">
                          {c.composite.toFixed(3)}
                        </span>
                        {favButton(c)}
                      </div>
                    </div>
                    <p className="text-xs text-gray-300 truncate font-mono">
                      {c.text ?? c.tokens.join(" ")}
                    </p>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <span className="text-gray-500">样本外 sortino</span>
                        <p className="text-emerald-400">{fmtNum(holdout?.sortino)}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">2× 成本 sortino</span>
                        <p className="text-red-400">{fmtNum(holdout?.sortino_2x)}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">换手</span>
                        <p className="text-white">{fmtNum(c.metrics.avg_turnover)}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 组合超级冠军:组合书在 2× 成本压力下的封存段计分 */}
        {stage === "completed" && activeTask?.portfolio && activeTask.portfolio.n_factors >= 2 && (() => {
          const pf = activeTask.portfolio
          const eq2 = pf.equal_2x?.sortino ?? -1
          const ic2 = pf.ic_weighted_2x?.sortino ?? -1
          const superOk = eq2 > 0 || ic2 > 0
          const rescued = superOk && (pf.any_member_research ?? false)
            && (pf.best_single_2x?.sortino ?? 0) <= 0
          return (
            <div className={`bg-[#1E2636]/50 backdrop-blur-sm rounded-2xl border p-6 space-y-4 ${
              superOk ? "border-emerald-500/30" : "border-white/5"
            }`}>
              <div className="flex items-center justify-between">
                <h2 className={`text-sm font-medium ${superOk ? "text-emerald-300" : "text-gray-300"}`}>
                  {superOk ? "★ 组合超级冠军" : "组合评估"} · {pf.n_factors} 因子
                  {(pf.any_member_research ?? false) && (
                    <span className="text-amber-300/80">（含 {pf.member_research?.filter(Boolean).length ?? 0} 个研究级）</span>
                  )}
                </h2>
                <span className="text-xs text-gray-500">
                  封存段 · 平均相关 |{pf.avg_abs_corr.toFixed(3)}|
                </span>
              </div>
              {rescued && (
                <p className="text-xs text-emerald-400/90 leading-relaxed">
                  组合救活：单个成员在 2× 成本下全部转负，但组合对冲降低了净换手与成本拖累，
                  组合书在加倍成本下依然盈利——1+1&gt;2 的分散化效果。
                </p>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div className="rounded-xl bg-[#0F131C]/50 border border-white/5 p-3">
                  <span className="text-gray-500">等权 · 1× 成本</span>
                  <p className="text-white font-mono text-base">{fmtNum(pf.equal?.sortino)}</p>
                </div>
                <div className={`rounded-xl bg-[#0F131C]/50 border p-3 ${eq2 > 0 ? "border-emerald-500/30" : "border-white/5"}`}>
                  <span className="text-gray-500">等权 · 2× 成本</span>
                  <p className={`font-mono text-base ${eq2 > 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtNum(pf.equal_2x?.sortino)}</p>
                </div>
                <div className="rounded-xl bg-[#0F131C]/50 border border-white/5 p-3">
                  <span className="text-gray-500">IC 加权 · 1×</span>
                  <p className="text-white font-mono text-base">{fmtNum(pf.ic_weighted?.sortino)}</p>
                </div>
                <div className={`rounded-xl bg-[#0F131C]/50 border p-3 ${ic2 > 0 ? "border-emerald-500/30" : "border-white/5"}`}>
                  <span className="text-gray-500">IC 加权 · 2×</span>
                  <p className={`font-mono text-base ${ic2 > 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtNum(pf.ic_weighted_2x?.sortino)}</p>
                </div>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                权重在训练段冻结（IC 截负归一），计分只在封存段；2× 口径为加倍交易成本的压力测试。
                最优单因子 2× sortino：{fmtNum(pf.best_single_2x?.sortino)}（对照：组合相对单因子的增益）。
              </p>
            </div>
          )
        })()}

        {/* 挂载:把冠军组合挂到服务器短线任务系统(纸面模式实时打分) */}
        {stage === "completed" && mountPool.length > 0 && (
          <div className="bg-[#1E2636]/50 backdrop-blur-sm rounded-2xl border border-white/5 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">挂载为服务器短线任务</h2>
              <span className="text-xs text-gray-500">纸面模式 · 实时流式打分</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
              <span>组合成员：{mountPool.length} 个{usingResearchPool ? "（研究级，样本外 1× 盈利、未过 2× 压力）" : ""}</span>
              <label className="flex items-center gap-1">
                打分节奏
                <select
                  value={cadence}
                  onChange={(e) => setCadence(Number(e.target.value) as CadenceSeconds)}
                  className="rounded-lg border border-white/10 bg-[#0F131C] px-2 py-1 text-white"
                >
                  <option value={3}>3s</option>
                  <option value={15}>15s</option>
                  <option value={60}>60s</option>
                </select>
              </label>
              <span>预热 {warmupBars} 根</span>
            </div>
            {!mountCheck.ok && (
              <p className="text-xs text-amber-400/90">
                {mountCheck.reasons.join("；")}——含 v4 订单流 token（{mountCheck.localOnlyTokens.length} 个）的因子
                依赖 aggTrades 逐笔数据,服务器 3s 级数据源接入前仅本地可用
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => void onMount()}
                disabled={mounting || !mountCheck.ok}
                className="rounded-xl bg-gradient-to-r from-[#38BDF8] to-[#6EE7B7] px-5 py-2.5 text-sm
                         font-semibold text-[#0A0D12] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {mounting ? "挂载中…" : "挂载组合"}
              </button>
              <button
                onClick={() => void refreshServerTasks()}
                className="text-xs text-gray-400 hover:text-gray-300 px-3 py-2 rounded-lg border border-white/10"
              >
                刷新任务列表
              </button>
            </div>
            {mountMsg && <p className="text-xs text-gray-400 break-all">{mountMsg}</p>}
            {serverTaskErr && (
              <p className="text-xs text-amber-400/90">服务器任务列表不可用：{serverTaskErr}（需登录且服务器可达）</p>
            )}
            {serverTasks && serverTasks.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-gray-500">服务器短线任务（{serverTasks.length}）：</p>
                {serverTasks.slice(0, 5).map((t) => (
                  <div key={String(t.id)} className="flex items-center justify-between text-xs bg-[#0F131C]/50 rounded-lg px-3 py-2">
                    <span className="font-mono text-gray-400">{String(t.id).slice(0, 8)} · {t.symbol?.toUpperCase?.() ?? t.symbol}</span>
                    <span className="text-gray-400">
                      {t.status}
                      {t.mode ? ` · ${t.mode}` : ""}
                      {t.position != null ? ` · 持仓 ${t.position}` : ""}
                      {t.cumulative_pnl != null ? ` · PnL ${t.cumulative_pnl.toFixed(2)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 启动按钮 */}
        {stage === "idle" && (
          <button
            onClick={onStartMining}
            disabled={!canStart}
            className="w-full rounded-2xl bg-gradient-to-r from-[#38BDF8] to-[#6EE7B7] px-6 py-4 text-base
                     font-semibold text-[#0A0D12] shadow-lg shadow-[#38BDF8]/20
                     hover:shadow-[#38BDF8]/40 disabled:opacity-50 disabled:cursor-not-allowed
                     transition-all duration-300"
          >
            {canStart ? "一键启动挖掘" : "任务运行中..."}
          </button>
        )}

        {/* 说明 */}
        <div className="rounded-xl bg-[#1E2636]/30 border border-white/5 p-4">
          <p className="text-xs text-gray-500 leading-relaxed">
            <strong className="text-gray-400">流程说明：</strong>
            系统将自动完成数据回填（{TIMEFRAME_BACKFILL_DAYS[timeframe]} 天）→ 因子挖掘（{population} 种群 × {generations} 代）→ 验证筛选。
            回填数据会缓存，二次运行秒启动。GPU 算力需 NVIDIA 显卡，CPU 为降级选择（慢 10-25×）。
            {showAdvanced && (
              <>
                <br /><br />
                <strong className="text-gray-400">防过拟合机制：</strong>
                Walk-Forward 验证（{walkForwardFolds} 折）确保因子在未见样本上稳定；训练集比例 {(trainRatio * 100).toFixed(0)}%
                保留充足验证数据；最大深度 {maxDepth} 限制公式复杂度。种群规模和代数平衡搜索广度与深度。
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
