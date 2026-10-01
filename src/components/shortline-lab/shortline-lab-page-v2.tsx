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

type Stage = "idle" | "backfill" | "mining" | "completed" | "failed"

export default function ShortlineLabPageV2() {
  // ── 核心参数（简化：只保留必需项） ──
  const [symbol, setSymbol] = useState(DEFAULT_SHORTLINE_SYMBOL)
  const [timeframe, setTimeframe] = useState<ShortlineTimeframe>("15m")
  const [engine, setEngine] = useState<"native-gpu" | "cpu">("native-gpu")

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
    const active = mine.find((t) => t.status === "running" || t.status === "pending")
    setActiveTask(active ?? null)

    if (active?.id) {
      const rows = await runner.champions(active.id)
      setChampions(rows.map((c) => ({
        tokens: c.tokens, text: c.text, composite: c.composite,
        metrics: c.metrics as unknown as Record<string, unknown>,
      })))
    } else {
      const done = mine.filter((t) => t.status === "completed").sort((a, b) =>
        (b.created_at ?? "").localeCompare(a.created_at ?? "")
      )[0]
      if (done?.id) {
        const rows = await runner.champions(done.id)
        setChampions(rows.map((c) => ({
          tokens: c.tokens, text: c.text, composite: c.composite,
          metrics: c.metrics as unknown as Record<string, unknown>,
        })))
      }
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
          population: 300,
          generations: 30,
          max_depth: 5,
          train_ratio: 0.7,
          walk_forward_folds: 3,
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

  // ── 监听任务完成 ──
  useEffect(() => {
    if (activeTask?.status === "completed") {
      setStage("completed")
      setProgress(100)
      setStatusMsg(`完成：发现 ${champions.length} 个冠军`)
    } else if (activeTask?.status === "failed") {
      setStage("failed")
      setError(activeTask.error_msg ?? "任务失败")
    } else if (activeTask?.status === "running") {
      setProgress(50 + (activeTask.progress_pct ?? 0) / 2)
      setStatusMsg(`挖掘中 ${activeTask.current_generation}/${activeTask.generations} 代`)
    }
  }, [activeTask, champions.length])

  // ── 停止 ──
  const onStop = () => {
    abortRef.current?.abort()
    if (activeTask?.id) runner.cancel(activeTask.id)
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

  const canStart = stage === "idle" && !activeTask

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
              </h2>
              {(stage === "backfill" || stage === "mining") && (
                <button
                  onClick={onStop}
                  className="text-xs text-red-400 hover:text-red-300 px-3 py-1 rounded-lg border border-red-500/30"
                >
                  停止
                </button>
              )}
              {(stage === "completed" || stage === "failed") && (
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
              <p className="text-xs text-gray-400">{statusMsg}</p>
            </div>

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
            系统将自动完成数据回填（{TIMEFRAME_BACKFILL_DAYS[timeframe]} 天）→ 因子挖掘（300 种群 × 30 代）→ 验证筛选。
            回填数据会缓存，二次运行秒启动。GPU 算力需 NVIDIA 显卡，CPU 为降级选择（慢 10-25×）。
          </p>
        </div>
      </div>
    </div>
  )
}
