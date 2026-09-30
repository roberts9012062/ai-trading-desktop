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
  digestUsage, listDayDigests, deleteDayDigests, runBackfillWithStore, missingRange,
} from "@/lib/shortline/backfill/pipeline"
import { loadDigestRange } from "@/lib/shortline/backfill/pipeline"
import {
  SHORTLINE_SYMBOLS, TIMEFRAME_BACKFILL_DAYS,
} from "@/lib/shortline/spec"
import { LiveScoringEngine } from "@/lib/shortline/live"
import { closedBarsFromDigest } from "@/lib/shortline/replay"
import { ScoreRingBuffer } from "@/lib/shortline/ring-buffer"
import {
  CADENCE_CHOICES, DEFAULT_SHORTLINE_SYMBOL, SHORTLINE_TIMEFRAMES,
  STALE_MULTIPLIER, type CadenceSeconds, type ShortlineTimeframe,
} from "@/lib/shortline/spec"
import { AggTradeStream } from "@/lib/shortline/ws"
import { buildShortlinePayload, checkMountable, requiredWarmupBars } from "@/lib/shortline/mount"
import { buildFixtureBundle, buildGoldenCase } from "@/lib/shortline/fixtures"
import { createShortlineTask } from "@/lib/shortline/server-api"

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
  // ── 表单状态（选择顺序：币种 → 周期 → 种群/代数 → 渠道 → 回填 → 引擎） ──
  const [symbol, setSymbol] = useState(DEFAULT_SHORTLINE_SYMBOL)
  const [timeframe, setTimeframe] = useState<ShortlineTimeframe>("15m")
  /** 数据渠道：binance_usdt=Binance USDT 永续归档直连(实测国内可达,K线与
   *  aggTrades 同源)；okx=服务器转发(国内直连不可达,K线为 OKX 口径,v4 订单
   *  流仍来自 Binance aggTrades——跨所拼接,研究参考)。 */
  const [channel, setChannel] = useState<"binance_usdt" | "okx">("binance_usdt")
  /** 挖掘算力：native-gpu=原生 GPU f64 精算(需 NVIDIA,推荐)；cpu=8-worker
   *  Pyodide 池(慢约 10-25×,无显卡时的降级选择)。 */
  const [engine, setEngine] = useState<"native-gpu" | "cpu">("native-gpu")

  // ── 回填管理（按所选币种；digest 为 1 秒桶,三周期共用一份增量缓存） ──
  const [usage, setUsage] = useState<{ days: number, bytes: number }>({ days: 0, bytes: 0 })
  const [cachedDays, setCachedDays] = useState<string[]>([])
  const [backfillFrom, setBackfillFrom] = useState("")
  const [backfillTo, setBackfillTo] = useState("")
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null)
  const [backfillBusy, setBackfillBusy] = useState(false)

  /** 建议区间（按周期：1m 30 天 / 5m 90 天 / 15m 180 天,对齐因子区间上限） */
  const suggestedFrom = useMemo(() => {
    const days = TIMEFRAME_BACKFILL_DAYS[timeframe]
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  }, [timeframe])
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const refreshUsage = useCallback(async (sym: string) => {
    setUsage(await digestUsage(sym))
    const days = (await listDayDigests(sym)).map((d) => d.day)
    setCachedDays(days)
    // 自动"只补最新"：区间起点 = 建议区间内的第一个缺口（无缓存则从头）
    const mr = missingRange(suggestedFrom, today, days)
    setBackfillFrom(mr.from)
    setBackfillTo(mr.to)
  }, [suggestedFrom, today])
  useEffect(() => { void refreshUsage(symbol) }, [refreshUsage, symbol])

  /** 回填增量说明（表单注释） */
  const coverage = useMemo(() => {
    if (!cachedDays.length) return "无缓存——将按建议区间全量下载"
    const inRange = cachedDays.filter((d) => d >= suggestedFrom && d <= today)
    if (!inRange.length) return `已缓存 ${cachedDays.length} 天（不含当前建议区间，将全量下载区间内数据）`
    return `已缓存 ${cachedDays.length} 天（${cachedDays[0]} → ${cachedDays[cachedDays.length - 1]}），本次只补缺口/最新`
  }, [cachedDays, suggestedFrom, today])

  const onBackfill = async () => {
    if (!backfillFrom || !backfillTo) return
    setBackfillBusy(true)
    setBackfillMsg(`回填 ${symbol} 启动…（每日归档约 20-80MB，即下即聚合为 digest；已缓存日自动跳过）`)
    try {
      const summary = await runBackfillWithStore({
        symbol,
        fromDay: backfillFrom,
        toDay: backfillTo,
        onProgress: (p) =>
          setBackfillMsg(`回填 ${symbol} ${p.index + 1}/${p.total} · ${p.day} ${p.status} · 累计 ${fmtBytes(p.cumulativeBytes)}`),
      })
      setBackfillMsg(
        `回填完成：成功 ${summary.done} 天 / 缺失 ${summary.missing} / 跳过(已缓存) ${summary.skipped} / 失败 ${summary.failed}，本次新增 ${fmtBytes(summary.totalBytes)}`
          + (summary.errors.length ? `；${summary.errors[0]!.error}` : ""),
      )
      await refreshUsage(symbol)
    } catch (e) {
      setBackfillMsg(`回填失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBackfillBusy(false)
    }
  }

  const onCleanup = async () => {
    const days = (await listDayDigests(symbol)).map((d) => d.day)
    // 保留最近 30 天（流式预热常用），其余清理
    const old = days.slice(0, Math.max(0, days.length - 30))
    if (old.length) await deleteDayDigests(symbol, old)
    await refreshUsage(symbol)
  }

  // ── 挖掘任务 ─────────────────────────────────────────────
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
          data_channel: channel,
        },
        {
          device: engine,
          name: `短线·${symbol}·${timeframe}·${cadence}s`,
          onProgress: (m) => setCreateMsg(m),
        },
      )
      setCreateMsg(`任务已创建：${task.id}（${engine === "native-gpu" ? "原生 GPU" : "CPU 多核"}；K线渠道 ${channel}；含 v4 特征列注入）`)
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

  // ── 挂载（M-D4） ─────────────────────────────────────────
  const mountChampions = useMemo(
    () => champions.slice(0, 5).map((c, i) => ({ id: i + 1, tokens: c.tokens })),
    [champions],
  )
  const mountCheck = useMemo(() => checkMountable(mountChampions.map((c) => c.tokens)), [mountChampions])
  const warmupBars = useMemo(
    () => (mountChampions.length ? requiredWarmupBars(mountChampions.map((c) => c.tokens), timeframe) : 300),
    [mountChampions, timeframe],
  )
  const [mountMsg, setMountMsg] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const onExportFixtures = async () => {
    setExporting(true)
    setMountMsg(null)
    try {
      const days = (await listDayDigests(symbol)).map((d) => d.day)
      if (!days.length) throw new Error("无 digest——请先回填 aggTrades")
      const last = days[days.length - 1]!
      const loaded = await loadDigestRange(symbol, last, last)
      if (!loaded) throw new Error("digest 载入失败")
      const formulas = mountChampions.map((c) => c.tokens)
      const cases = [3, 15, 60].map((cad) => buildGoldenCase({
        name: `${symbol}-${timeframe}-${cad}s-${last}`,
        symbol, timeframe, cadence: cad as CadenceSeconds,
        buckets: loaded.buckets, formulas,
      }))
      const bundle = buildFixtureBundle(symbol, cases, formulas)
      const blob = new Blob([JSON.stringify({ fixture: bundle.fixture, manifest: bundle.manifest }, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `shortline-golden-fixture-${symbol}-${timeframe}.json`
      a.click()
      URL.revokeObjectURL(url)
      setMountMsg(`黄金夹具已导出（${cases.length} cadence × ${formulas.length} 公式；manifest ${bundle.manifest.manifest_sha256.slice(0, 12)}…）`)
    } catch (e) {
      setMountMsg(`夹具导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  const onMount = async () => {
    setMountMsg("导出夹具并组装载荷…")
    try {
      const days = (await listDayDigests(symbol)).map((d) => d.day)
      if (!days.length) throw new Error("无 digest——请先回填 aggTrades")
      const last = days[days.length - 1]!
      const loaded = await loadDigestRange(symbol, last, last)
      if (!loaded) throw new Error("digest 载入失败")
      const formulas = mountChampions.map((c) => c.tokens)
      const cases = [3, 15, 60].map((cad) => buildGoldenCase({
        name: `${symbol}-${timeframe}-${cad}s-${last}`,
        symbol, timeframe, cadence: cad as CadenceSeconds,
        buckets: loaded.buckets, formulas,
      }))
      const bundle = buildFixtureBundle(symbol, cases, formulas)
      const payload = buildShortlinePayload(
        { symbol, timeframe, cadence, champions: mountChampions, warmupBars: warmupBars },
        bundle.manifest.manifest_sha256,
      )
      const task = await createShortlineTask(payload)
      setMountMsg(`挂载成功：任务 ${task.id}（${task.status ?? "created"}）`)
    } catch (e) {
      setMountMsg(
        `挂载失败：${e instanceof Error ? e.message : String(e)}（服务器短线任务系统 M-S1 交付后联调；夹具与载荷 schema 已就绪）`,
      )
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">短线因子实验室</h1>
        <p className="text-xs text-[var(--text-muted)]">
          1m/5m/15m 短线因子挖掘（shortline_v1 档案 · aggTrades 订单流 v4 特征 · 换手/翻转/半衰期惩罚），
          tick 重放与流式打分共用同一套形成中 K 线代码。打分节奏 ≠ 交易节奏；流式预览纯展示，不下单。
        </p>
      </div>

      {/* 回填管理：按所选币种下载 aggTrades 归档 → 1 秒桶 digest（增量缓存，三周期共用） */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">第 4 步 · aggTrades 回填（{symbol}）</h2>
          <span className="text-[10px] text-[var(--text-muted)] font-num">
            本币 {usage.days} 天 · {fmtBytes(usage.bytes)} / 全局预算 3 GB（跨币种共享）
          </span>
        </div>
        <p className="text-[10px] text-[var(--text-muted)]">
          按上方选择的币种回填其成交归档（data.binance.vision，国内实测可达）。digest 为 1 秒桶、
          与周期无关——{timeframe} 只决定建议区间（当前 {TIMEFRAME_BACKFILL_DAYS[timeframe]} 天）；1m/5m/15m 三周期共用同一份缓存。
        </p>
        <p className="text-[10px] text-emerald-400/90">{coverage}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1" />
          <span className="text-[var(--text-muted)]">→</span>
          <input type="date" value={backfillTo} onChange={(e) => setBackfillTo(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1" />
          <button onClick={onBackfill} disabled={backfillBusy || !backfillFrom || !backfillTo}
            className="px-3 py-1 rounded-md bg-[var(--primary)] text-white disabled:opacity-40">
            {backfillBusy ? "回填中…" : "回填（只补缺失/最新）"}
          </button>
          <button onClick={() => { setBackfillFrom(suggestedFrom); setBackfillTo(today) }} disabled={backfillBusy}
            className="px-3 py-1 rounded-md border border-[var(--border)] text-[var(--text-muted)]">
            按建议区间全选
          </button>
          <button onClick={onCleanup} disabled={backfillBusy}
            className="px-3 py-1 rounded-md border border-[var(--border)] text-[var(--text-muted)]">
            清理（保留最近 30 天）
          </button>
        </div>
        {backfillMsg && <p className="text-[10px] text-[var(--text-muted)]">{backfillMsg}</p>}
      </section>

      {/* 挖掘表单：选择顺序 = 币种 → 周期 → 种群/代数 → 成本/cadence → 数据渠道；每项带注释 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">第 1-3 步 · 挖掘参数（收盘 K 线训练，shortline_v1 档案）</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          {/* 1 币种：USDT 永续可挖列表（aggTrades/v4 订单流以 Binance UM 为源） */}
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">① 币种（USDT 永续）</span>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1">
              {SHORTLINE_SYMBOLS.map((sym) => <option key={sym} value={sym}>{sym}</option>)}
            </select>
            <span className="text-[10px] text-[var(--text-muted)] block leading-4">
              12 个主流币均具备 ≥2 年永续历史；aggTrades 回填与 v4 订单流特征以 Binance UM 归档为源。
            </span>
          </label>
          {/* 2 周期：决定归一化窗口与建议回填区间 */}
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">② 周期</span>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as ShortlineTimeframe)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1">
              {SHORTLINE_TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <span className="text-[10px] text-[var(--text-muted)] block leading-4">
              特征归一化窗口随周期自动放大（1m≈1440 根/日）；打分 cadence 在流式预览区另选。
            </span>
          </label>
          {/* 数据渠道：国内可达性实测标注 */}
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">⑥ 数据渠道（USDT 永续）</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value as "binance_usdt" | "okx")}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1">
              <option value="binance_usdt">Binance USDT 永续 · 归档直连（推荐）</option>
              <option value="okx">OKX 合约 · 服务器转发</option>
            </select>
            <span className="text-[10px] text-[var(--text-muted)] block leading-4">
              Binance 归档域 data.binance.vision 国内实测可达（K线/资金费率/aggTrades 同源，口径一致）；
              OKX 国内直连不可达，走服务器转发，且 v4 订单流仍来自 Binance aggTrades（跨所拼接，仅研究参考）。
            </span>
          </label>
          {/* 3 种群：10–30000（与因子实验室同界），上限注释 */}
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">③ 种群数量（10 – 30000）</span>
            <input type="number" value={population} min={10} max={30000} step={10}
              onChange={(e) => setPopulation(Number(e.target.value))}
              onBlur={() => setPopulation(Math.min(30000, Math.max(10, Math.round(population) || 300)))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
            <span className="text-[10px] text-[var(--text-muted)] block leading-4">
              每代同时评估的候选公式数，最大 30000（引擎上限，超级因子极限档为 10000）。越大搜索面越广、耗时越长；
              原生 GPU 粗排吞吐高可放心开大，CPU 多核建议 ≤500。
            </span>
          </label>
          {/* 4 代数：3–1000（与因子实验室同界），上限注释 */}
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">④ 代数（3 – 1000）</span>
            <input type="number" value={generations} min={3} max={1000} step={5}
              onChange={(e) => setGenerations(Number(e.target.value))}
              onBlur={() => setGenerations(Math.min(1000, Math.max(3, Math.round(generations) || 30)))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
            <span className="text-[10px] text-[var(--text-muted)] block leading-4">
              遗传迭代轮数，最大 1000（引擎上限）。每代保留优胜者再交叉/变异；新手建议 15，GPU 长跑可开到数百。
            </span>
          </label>
          {/* 5 成本（bp/单边）与 cadence */}
          <label className="space-y-1">
            <span className="text-[var(--text-muted)]">⑤ 成本（bp/单边）</span>
            <input type="number" value={costBp} min={1} max={50}
              onChange={(e) => setCostBp(Number(e.target.value))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 font-num" />
            <span className="text-[10px] text-[var(--text-muted)] block leading-4">
              单边换手成本率（1bp=0.01%）。短线毛边际薄，建议 ≥3bp 保守评估；打分 cadence（3-60s）在下方流式预览选择。
            </span>
          </label>
        </div>

        {/* 7 挖掘算力：CPU / GPU */}
        <div className="space-y-1">
          <span className="text-xs text-[var(--text-muted)]">⑦ 挖掘算力</span>
          <div className="flex items-center gap-2 text-xs">
            <button type="button" onClick={() => setEngine("native-gpu")}
              className={`px-3 py-1.5 rounded-md border ${engine === "native-gpu" ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text-primary)]" : "border-[var(--border)] text-[var(--text-muted)]"}`}>
              原生 GPU（f64 精算 · 推荐）
            </button>
            <button type="button" onClick={() => setEngine("cpu")}
              className={`px-3 py-1.5 rounded-md border ${engine === "cpu" ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text-primary)]" : "border-[var(--border)] text-[var(--text-muted)]"}`}>
              CPU 多核（Pyodide 池）
            </button>
          </div>
          <p className="text-[10px] text-[var(--text-muted)]">
            原生 GPU 需 NVIDIA 显卡（Taichi/CUDA sidecar，粗排+精算全链 GPU，冷启动首编译约 2-6 分钟）；
            CPU 为 8-worker Pyodide 池，慢约 10-25×，作为无卡环境降级。两者数值口径一致（G2 对拍锁定）。
          </p>
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
            <select value={cadence} onChange={(e) => setCadence(Number(e.target.value) as CadenceSeconds)}
              title="打分节奏：每 N 秒对形成中 K 线打一次分（打分节奏 ≠ 交易节奏，仅影响分数流密度）"
              className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs">
              {CADENCE_CHOICES.map((c) => <option key={c} value={c}>{c}s</option>)}
            </select>
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

      {/* 挂载到服务器（M-D4） */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">挂载到服务器（shortline_factor_v1 · 纸面模式默认）</h2>
        <p className="text-[10px] text-[var(--text-muted)] font-num">
          待挂冠军 {mountChampions.length} 个 · warmup_bars {warmupBars} · cadence {cadence}s
          {mountCheck.localOnlyTokens.length ? ` · 含仅本地 token：${mountCheck.localOnlyTokens.join(",")}` : ""}
        </p>
        {!mountCheck.ok && (
          <ul className="text-[10px] text-amber-400 space-y-0.5 list-disc pl-4">
            {mountCheck.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <button onClick={onExportFixtures} disabled={exporting || !mountChampions.length}
            className="px-3 py-1 rounded-md border border-[var(--border)] text-xs disabled:opacity-40">
            {exporting ? "导出中…" : "导出黄金夹具（带 manifest SHA）"}
          </button>
          <button onClick={onMount} disabled={!mountChampions.length || !mountCheck.ok}
            className="px-3 py-1 rounded-md bg-[var(--primary)] text-white text-xs disabled:opacity-40">
            挂载到服务器
          </button>
        </div>
        {mountMsg && <p className="text-[10px] text-[var(--text-muted)]">{mountMsg}</p>}
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
