"use client"

/**
 * 短线因子实验室页面（方案 B §1）。
 *
 * 结构:回填管理(aggTrades digest) → 挖掘表单/任务进度(shortline_v1 profile)
 * → 冠军表(翻转率/半衰期/打分稳定性) → 流式打分预览(同一套 forming-bar/
 * evaluator 代码;纯预览不下单) → 挂载到服务器(M-D4 接线)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRunner } from "@/lib/mining/runner"
import type { MiningTask } from "@/lib/mining/types"
import {
  digestUsage, listDayDigests, deleteDayDigests, runBackfillWithStore,
} from "@/lib/shortline/backfill/pipeline"
import { loadDigestRange } from "@/lib/shortline/backfill/pipeline"
import { LiveScoringEngine } from "@/lib/shortline/live"
import { closedBarsFromDigest } from "@/lib/shortline/replay"
import { ScoreRingBuffer } from "@/lib/shortline/ring-buffer"
import {
  CADENCE_CHOICES, DEFAULT_SHORTLINE_SYMBOL, SHORTLINE_TIMEFRAMES,
  STALE_MULTIPLIER, type CadenceSeconds, type ShortlineTimeframe,
} from "@/lib/shortline/spec"
import { AggTradeStream } from "@/lib/shortline/ws"

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

export default function ShortlineLabPage() {
  // ── 回填管理 ─────────────────────────────────────────────
  const [usage, setUsage] = useState<{ days: number, bytes: number }>({ days: 0, bytes: 0 })
  const [backfillFrom, setBackfillFrom] = useState("")
  const [backfillTo, setBackfillTo] = useState("")
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null)
  const [backfillBusy, setBackfillBusy] = useState(false)

  const refreshUsage = useCallback(async () => {
    setUsage(await digestUsage(DEFAULT_SHORTLINE_SYMBOL))
  }, [])
  useEffect(() => { void refreshUsage() }, [refreshUsage])

  const onBackfill = async () => {
    if (!backfillFrom || !backfillTo) return
    setBackfillBusy(true)
    setBackfillMsg("回填启动…（每日归档约 20-80MB，即下即聚合为 digest）")
    try {
      const summary = await runBackfillWithStore({
        symbol: DEFAULT_SHORTLINE_SYMBOL,
        fromDay: backfillFrom,
        toDay: backfillTo,
        onProgress: (p) =>
          setBackfillMsg(`回填 ${p.index + 1}/${p.total} · ${p.day} ${p.status} · 累计 ${fmtBytes(p.cumulativeBytes)}`),
      })
      setBackfillMsg(
        `回填完成：成功 ${summary.done} 天 / 缺失 ${summary.missing} / 跳过 ${summary.skipped} / 失败 ${summary.failed}，占用 ${fmtBytes(summary.totalBytes)}`
          + (summary.errors.length ? `；${summary.errors[0]!.error}` : ""),
      )
      await refreshUsage()
    } catch (e) {
      setBackfillMsg(`回填失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBackfillBusy(false)
    }
  }

  const onCleanup = async () => {
    const days = (await listDayDigests(DEFAULT_SHORTLINE_SYMBOL)).map((d) => d.day)
    // 保留最近 30 天（流式预热常用），其余清理
    const old = days.slice(0, Math.max(0, days.length - 30))
    if (old.length) await deleteDayDigests(DEFAULT_SHORTLINE_SYMBOL, old)
    await refreshUsage()
  }

  // ── 挖掘任务 ─────────────────────────────────────────────
  const [symbol] = useState(DEFAULT_SHORTLINE_SYMBOL)
  const [timeframe, setTimeframe] = useState<ShortlineTimeframe>("15m")
  const [population, setPopulation] = useState(300)
  const [generations, setGenerations] = useState(30)
  const [costBp, setCostBp] = useState(3)
  const [cadence, setCadence] = useState<CadenceSeconds>(15)
  const [tasks, setTasks] = useState<MiningTask[]>([])
  const [creating, setCreating] = useState(false)
  const [champions, setChampions] = useState<ChampionLite[]>([])
  const [createMsg, setCreateMsg] = useState<string | null>(null)

  const refreshTasks = useCallback(async () => {
    const all = await runner.list()
    const mine = all.filter((t) => t.config?.research_profile === "shortline_v1")
    setTasks(mine)
    const source = mine.find((t) => t.status === "running" || t.status === "pending") ?? undefined
    const done = [...mine].filter((t) => t.status === "completed").sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]
    const id = source?.id ?? done?.id
    if (id) {
      const rows = await runner.champions(id)
      setChampions(rows.map((c) => ({
        tokens: c.tokens, text: c.text, composite: c.composite,
        metrics: (c.metrics ?? {}) as unknown as Record<string, unknown>,
      })))
    }
  }, [])
  useEffect(() => {
    void refreshTasks()
    const unsub = runner.subscribe(() => void refreshTasks())
    return () => { unsub?.() }
  }, [refreshTasks])

  const activeTask = useMemo(
    () => tasks.find((t) => t.status === "running" || t.status === "pending") ?? null,
    [tasks],
  )
  const latestDone = useMemo(
    () => [...tasks].filter((t) => t.status === "completed").sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0] ?? null,
    [tasks],
  )

  const onCreateTask = async () => {
    setCreating(true)
    setCreateMsg(null)
    try {
      const task = await runner.create(
        {
          symbol,
          timeframe,
          population,
          generations,
          max_depth: 5,
          train_ratio: 0.7,
          walk_forward_folds: 3,
          selection_v2: true,
          evolve_v2: true,
          research_profile: "shortline_v1",
          cost: costBp / 10000,
          native_precision: "mixed",
        },
        {
          device: "native-gpu",
          name: `短线·${symbol}·${timeframe}·${cadence}s`,
          onProgress: (m) => setCreateMsg(m),
        },
      )
      setCreateMsg(`任务已创建：${task.id}（原生 GPU；含 v4 特征列注入）`)
      await refreshTasks()
    } catch (e) {
      setCreateMsg(`创建失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCreating(false)
    }
  }

  // ── 流式打分预览 ─────────────────────────────────────────
  const [previewOn, setPreviewOn] = useState(false)
  const [previewStatus, setPreviewStatus] = useState<"idle" | "connecting" | "open" | "closed" | "warming">("idle")
  const [previewMsg, setPreviewMsg] = useState<string | null>(null)
  const ringRef = useRef(new ScoreRingBuffer())
  const [, forceRender] = useState(0)

  const previewChampions = useMemo(
    () => champions.slice(0, 5).map((c) => ({ tokens: c.tokens })),
    [champions],
  )

  useEffect(() => {
    if (!previewOn || !previewChampions.length) return
    let engine: LiveScoringEngine | null = null
    let stream: AggTradeStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let disposed = false
    let lastSampleAt = 0

    void (async () => {
      setPreviewStatus("warming")
      setPreviewMsg("加载 digest 预热…")
      // 预热:最近 digest 日 → closed bars
      const days = (await listDayDigests(symbol)).map((d) => d.day)
      let warmupBars: ReturnType<typeof closedBarsFromDigest> = []
      if (days.length) {
        const recent = days.slice(-2)
        const loaded = await loadDigestRange(symbol, recent[0]!, recent[recent.length - 1]!)
        if (loaded && loaded.buckets.length) {
          const spanSec = timeframe === "1m" ? 60 : timeframe === "5m" ? 300 : 900
          const tailStart = loaded.buckets[loaded.buckets.length - 1]!.ts * 1000 - spanSec * 1000 * 400
          warmupBars = closedBarsFromDigest(
            loaded.buckets, timeframe,
            Math.floor(tailStart / (spanSec * 1000)) * spanSec * 1000,
            loaded.buckets[loaded.buckets.length - 1]!.ts * 1000,
          )
        }
      }
      if (disposed) return
      engine = new LiveScoringEngine({
        timeframe, cadence, champions: previewChampions,
        warmupBars: warmupBars.length ? warmupBars : undefined,
      })
      setPreviewMsg(`预热 ${warmupBars.length} 根（${warmupBars.length < 60 ? "不足，分数将延迟稳定" : "OK"}）`)

      stream = new AggTradeStream({
        symbol,
        onEvent: (e) => engine?.onAggTrade(e),
        onStatus: (s) => setPreviewStatus(s === "open" ? "open" : s === "connecting" ? "connecting" : "closed"),
      })
      stream.start()

      timer = setInterval(() => {
        if (!engine) return
        const now = Date.now()
        const grid = Math.ceil(now / (cadence * 1000)) * cadence * 1000
        if (grid === lastSampleAt) return
        lastSampleAt = grid
        const sample = engine.onCadence(grid)
        ringRef.current.markStale(Date.now(), cadence, STALE_MULTIPLIER)
        if (sample) {
          ringRef.current.push({ ...sample, localMs: Date.now(), stale: false })
          forceRender((n) => n + 1)
        }
      }, Math.max(250, cadence * 250))
    })()

    return () => {
      disposed = true
      stream?.stop()
      if (timer) clearInterval(timer)
    }
  }, [previewOn, previewChampions, cadence, symbol, timeframe])

  const ring = ringRef.current.list()


  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">短线因子实验室</h1>
        <p className="text-xs text-[var(--text-muted)]">
          1m/5m/15m 短线因子挖掘（shortline_v1 档案 · aggTrades 订单流 v4 特征 · 换手/翻转/半衰期惩罚），
          tick 重放与流式打分共用同一套形成中 K 线代码。打分节奏 ≠ 交易节奏；流式预览纯展示，不下单。
        </p>
      </div>

      {/* 回填管理 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">aggTrades 回填（{symbol}）</h2>
          <span className="text-[10px] text-[var(--text-muted)] font-num">
            {usage.days} 天 · {fmtBytes(usage.bytes)} / 预算 3 GB
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1" />
          <span className="text-[var(--text-muted)]">→</span>
          <input type="date" value={backfillTo} onChange={(e) => setBackfillTo(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1" />
          <button onClick={onBackfill} disabled={backfillBusy || !backfillFrom || !backfillTo}
            className="px-3 py-1 rounded-md bg-[var(--primary)] text-white disabled:opacity-40">
            {backfillBusy ? "回填中…" : "开始回填"}
          </button>
          <button onClick={onCleanup} disabled={backfillBusy}
            className="px-3 py-1 rounded-md border border-[var(--border)] text-[var(--text-muted)]">
            清理（保留最近 30 天）
          </button>
        </div>
        {backfillMsg && <p className="text-[10px] text-[var(--text-muted)]">{backfillMsg}</p>}
      </section>

      {/* 挖掘表单 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">挖掘任务（收盘 K 线训练 · 原生 GPU f64 权威）</h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">品种</span>
            <input value={symbol} readOnly
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">周期</span>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as ShortlineTimeframe)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1">
              {SHORTLINE_TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">种群</span>
            <input type="number" value={population} min={40} step={20}
              onChange={(e) => setPopulation(Number(e.target.value))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">代数</span>
            <input type="number" value={generations} min={5} step={5}
              onChange={(e) => setGenerations(Number(e.target.value))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">成本(bp/单边)</span>
            <input type="number" value={costBp} min={1} max={50}
              onChange={(e) => setCostBp(Number(e.target.value))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
          </label>
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">打分 cadence</span>
            <select value={cadence} onChange={(e) => setCadence(Number(e.target.value) as CadenceSeconds)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1">
              {CADENCE_CHOICES.map((c) => <option key={c} value={c}>{c}s</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onCreateTask} disabled={creating || Boolean(activeTask)}
            className="px-3 py-1.5 rounded-md bg-[var(--primary)] text-white text-xs disabled:opacity-40">
            {activeTask ? "已有任务运行中" : creating ? "创建中…" : "创建挖掘任务"}
          </button>
          {createMsg && <span className="text-[10px] text-[var(--text-muted)] truncate">{createMsg}</span>}
        </div>
        {activeTask && (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
              <div className="h-full bg-[var(--primary)]" style={{ width: `${activeTask.progress_pct}%` }} />
            </div>
            <p className="text-[10px] text-[var(--text-muted)] font-num">
              {activeTask.name} · 第 {activeTask.current_generation}/{activeTask.generations} 代 ·
              最优 {activeTask.best_composite.toFixed(2)} · 冠军 {activeTask.champions_count}
              {activeTask.nativePhase ? ` · ${activeTask.nativePhase}` : ""}
            </p>
          </div>
        )}
      </section>

      {/* 冠军表 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-2">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          冠军（{champions.length ? `来自 ${latestDone?.name ?? activeTask?.name}` : "暂无冠军"}）
        </h2>
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left">
            <thead className="text-[10px] text-[var(--text-muted)]">
              <tr>
                <th className="py-1 pr-2">公式</th>
                <th className="py-1 pr-2 font-num">composite</th>
                <th className="py-1 pr-2 font-num">翻转率</th>
                <th className="py-1 pr-2 font-num">半衰期(bar)</th>
                <th className="py-1 pr-2 font-num">avg换手</th>
                <th className="py-1">IC</th>
              </tr>
            </thead>
            <tbody className="font-num">
              {champions.slice(0, 10).map((c, i) => (
                <tr key={i} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2 truncate max-w-[260px]" title={c.text ?? c.tokens.join(" ")}>
                    {c.text ?? c.tokens.join(" ")}
                  </td>
                  <td className="py-1 pr-2">{c.composite.toFixed(3)}</td>
                  <td className="py-1 pr-2">{fmtNum(c.metrics.flip_rate)}</td>
                  <td className="py-1 pr-2">{fmtNum(c.metrics.half_life)}</td>
                  <td className="py-1 pr-2">{fmtNum(c.metrics.avg_turnover)}</td>
                  <td className="py-1">{fmtNum(c.metrics.ts_ic)}</td>
                </tr>
              ))}
              {!champions.length && (
                <tr><td colSpan={6} className="py-3 text-center text-[var(--text-muted)]">尚无冠军（0 合法：门未过即无产出，不为产出放宽指标）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 流式打分预览 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">流式打分预览（{cadence}s · 不下单）</h2>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              previewStatus === "open" ? "bg-emerald-600/15 text-emerald-400"
              : previewStatus === "closed" ? "bg-red-500/15 text-red-400"
              : "bg-amber-500/15 text-amber-400"}`}>
              {previewStatus === "open" ? "实时流" : previewStatus === "warming" ? "预热中" : previewStatus === "connecting" ? "连接中" : previewStatus === "closed" ? "已断开" : "未启动"}
            </span>
            <button onClick={() => { setPreviewOn((v) => !v); if (previewOn) setPreviewStatus("idle") }}
              disabled={!previewChampions.length}
              className="px-3 py-1 rounded-md bg-[var(--primary)] text-white text-xs disabled:opacity-40">
              {previewOn ? "停止" : "启动预览"}
            </button>
          </div>
        </div>
        {!previewChampions.length && (
          <p className="text-[10px] text-[var(--text-muted)]">需要至少 1 个冠军（完成一次挖掘任务）</p>
        )}
        {previewMsg && <p className="text-[10px] text-[var(--text-muted)]">{previewMsg}</p>}
        {ring.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-baseline gap-3">
              <span className="text-[10px] text-[var(--text-muted)]">组合分(最近)</span>
              <span className="text-xl font-num text-[var(--text-primary)]">
                {fmtScore(ring[ring.length - 1]?.combo)}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] font-num">
                {ring.length}/50 步 · 陈旧 {ring.filter((s) => s.stale).length}
              </span>
            </div>
            {/* 简易分数序列条（最近 50 步） */}
            <div className="flex items-end gap-[2px] h-16">
              {ring.map((s, i) => {
                const v = s.combo ?? 0
                const h = Math.min(100, Math.abs(v) * 100)
                return (
                  <div key={i} title={`t=${new Date(s.t).toISOString()} combo=${fmtScore(s.combo)}${s.stale ? " (陈旧)" : ""}`}
                    className={`flex-1 min-w-[3px] ${s.stale ? "opacity-30" : ""} ${v >= 0 ? "bg-emerald-500/70" : "bg-red-500/70"}`}
                    style={{ height: `${Math.max(4, h)}%` }} />
                )
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function fmtNum(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "—"
}

function fmtScore(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return v.toFixed(4)
}
