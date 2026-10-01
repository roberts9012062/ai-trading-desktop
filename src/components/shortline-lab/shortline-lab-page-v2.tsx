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
import {
  digestUsage, runBackfillWithStore, missingRange, listDayDigests,
} from "@/lib/shortline/backfill/pipeline"
import {
  SHORTLINE_SYMBOLS, TIMEFRAME_BACKFILL_DAYS, DEFAULT_SHORTLINE_SYMBOL,
  SHORTLINE_TIMEFRAMES, type ShortlineTimeframe,
} from "@/lib/shortline/spec"

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

type Stage = "idle" | "backfill" | "mining" | "completed" | "failed" | "paused"

export default function ShortlineLabPageV2() {
  // ── 核心参数（简化：只保留必需项） ──
  const [symbol, setSymbol] = useState(DEFAULT_SHORTLINE_SYMBOL)
  const [timeframe, setTimeframe] = useState<ShortlineTimeframe>("15m")
  const [engine, setEngine] = useState<"native-gpu" | "cpu">("native-gpu")

  // ── 高级参数（默认值 + 用户可调） ──
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [population, setPopulation] = useState(300)
  const [generations, setGenerations] = useState(30)
  const [maxDepth, setMaxDepth] = useState(5)
  const [trainRatio, setTrainRatio] = useState(0.7)
  const [walkForwardFolds, setWalkForwardFolds] = useState(3)

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
          cost: 0.0003,
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
      setStatusMsg(`完成：发现 ${champions.length} 个冠军`)
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
  }, [activeTask?.id, activeTask?.status, activeTask?.current_generation, activeTask?.generations, activeTask?.nativePhase, champions.length])

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
                  <p className="text-xs text-gray-600">默认 300，影响搜索广度</p>
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
                  <p className="text-xs text-gray-600">默认 30，更多代数=更深搜索</p>
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
                      setPopulation(300)
                      setGenerations(30)
                      setMaxDepth(5)
                      setTrainRatio(0.7)
                      setWalkForwardFolds(3)
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
                    <span className="text-sm font-semibold text-[#38BDF8]">
                      {c.composite.toFixed(3)}
                    </span>
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
