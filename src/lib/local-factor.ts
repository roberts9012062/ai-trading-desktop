import { gateResearchRange } from "@/lib/crypto-direct"
/**
 * 因子实验室本地引擎门面(Pyodide + numpy / WebGPU)
 *
 * CPU:走分代步进会话(mine_start/mine_step)——与一次性 search() 逐位一致
 * (scripts/verify-mine-stepwise.py 验证),且能上报真实进度「第 g/G 代 · 当前最优 x」;
 * GPU:GpuBackend 粗排(WGSL f32)+ 每代 Pyodide f64 精算,对外数字出自内核。
 * LLM 教练/路线B生成/收藏仍走服务端;本地搜索结果经
 * POST /api/factor-lab/history 落服务端历史(端点未上线时静默降级)。
 */

import { isCryptoSymbol } from "@/lib/mining/crypto-profile"
import { fetchBacktestBars, KLINE_MAX_PAGES } from "@/lib/local-backtest"
import { normalizeChannel } from "@/lib/kline-channels"
import type { Champion, FactorBacktestResult, SearchResult } from "@/lib/factor-lab-api"
import type { KlineBar } from "@/types"

export interface LocalFactorPayload {
  crypto_profile?: boolean
  symbol: string
  timeframe: string
  population: number
  generations: number
  top_n: number
  seed: number
  /** GPU 路径的树深(默认 4;CPU 会话经 _CFG_FIELDS 白名单透传) */
  max_depth?: number
  cost?: number | null
  seed_tokens?: number[][]
  mutation_p?: number
  crossover_p?: number
  train_ratio?: number
  test_recent_bars?: number
  walk_forward_folds?: number
  /** 数据渠道(okx/binance_spot/gate_spot;缺省 binance_spot) */
  data_channel?: string
  /** 本地增强(内核 SearchConfig 同名字段,默认关;见 MiningConfig 注释) */
  selection_v2?: boolean
  evolve_v2?: boolean
  live_entry_gate?: number
  /** v2 研究契约(crypto_local_v2)与执行模型(方案 §3;经 _CFG_FIELDS 白名单透传) */
  research_profile?: string
  execution_model?: string
  label_span?: number
  start_date?: string
  end_date?: string
}

export type LocalSearchEngine = "cpu" | "gpu"

/** 本地搜索的结构化进度(GenerationStep 摘要;与超级因子任务面板同源数据) */
export interface LocalSearchStep {
  /** 已完成代数(1-based) */
  generation: number
  totalGenerations: number
  bestComposite: number
  /** 本代耗时 ms */
  elapsedMs: number
  /** 精算分片并行 worker 数;0=单进程降级(单核) */
  shardWorkers: number
  /** 本代评估候选数(整个种群) */
  evaluated: number
  /** 其中任务级缓存命中数(未重算) */
  cacheHits: number
  /** 本代并行评估耗时 ms(分片池墙钟) */
  rankMs: number
  /** 本代主实例单点精算耗时 ms(严格筛合并/walk-forward/权威排行,单核段) */
  preciseMs: number
  engine: LocalSearchEngine
}

/**
 * 搜索时冻结的行情快照(方案任务 3 / 问题 H):单因子复测复用同一份 bars
 * 与已解析成本,不按新拉行情或末端价格重算——搜索后网络原始数据被修订,
 * 复测仍复现原结果。只保留最近一次搜索的快照(内存有界);超级因子入口
 * 走 IDB 快照层(data-source),此处覆盖因子实验室入口。
 */
export interface SearchBarsSnapshot {
  key: string
  symbol: string
  timeframe: string
  channel?: string
  bars: KlineBar[]
  /** 搜索实际取数区间(与复测请求比对:一致才复用) */
  startDate: string
  endDate: string
  /** 搜索时冻结的已解析成本(内核 resolve_search_cost 口径) */
  cost: number | null
  researchProfile?: string
}

let lastSearchSnapshot: SearchBarsSnapshot | null = null

export function getLastSearchSnapshot(): SearchBarsSnapshot | null {
  return lastSearchSnapshot
}

export function clearSearchSnapshot(): void {
  lastSearchSnapshot = null
}

function snapshotKey(symbol: string, timeframe: string, channel?: string): string {
  return `${symbol}:${channel ?? ""}:${timeframe}`
}

interface MineStepResult {
  done?: boolean
  error?: string
  generation?: number
  total_generations?: number
  best_composite?: number
  champions?: Champion[]
}

/** 给冠军打内核版本戳(best-effort,发布前清单第 2 步的本地侧) */
async function stampKernelVersion(champions: Champion[]): Promise<void> {
  try {
    const { ensurePyWorker } = await import("@/lib/py-worker")
    const v = (await ensurePyWorker().factorRun({ mode: "version" }, [], 30_000)) as {
      kernel_version?: string
    }
    if (v?.kernel_version) {
      for (const c of champions) {
        ;c.metrics.kernel_version = v.kernel_version
      }
    }
  } catch {
    // 版本戳缺失只影响旧口径提示,不影响搜索本身
  }
}

function toSearchResult(
  payload: LocalFactorPayload,
  bars: KlineBar[],
  champions: Champion[],
  portfolio: SearchResult["portfolio"],
): SearchResult {
  return {
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    bars: bars.length,
    range: {
      from: bars[0]?.time ?? null,
      to: bars.length > 0 ? bars[bars.length - 1].time : null,
    },
    champions,
    portfolio,
    coach_note: null,
  } as SearchResult
}

/** 搜索完成后对冠军做组合评估(等权/IC 加权 vs 最优单因子;best-effort,失败返回 null) */
async function evaluatePortfolio(
  payload: LocalFactorPayload,
  bars: KlineBar[],
  champions: Champion[],
): Promise<SearchResult["portfolio"]> {
  if (champions.length < 2) return null
  try {
    const { ensurePyWorker } = await import("@/lib/py-worker")
    const res = (await ensurePyWorker().factorRun(
      {
        mode: "mine_portfolio",
        crypto_profile: payload.crypto_profile,
        symbol: payload.symbol,
        timeframe: payload.timeframe,
        cost: payload.cost ?? null,
        tokens_list: champions.map((c) => c.tokens),
        // 只在样本外段评估(增强遴选时只用封存段),避免样本内虚高
        ...(payload.train_ratio ? { train_ratio: payload.train_ratio } : {}),
        ...(payload.test_recent_bars != null ? { test_recent_bars: payload.test_recent_bars } : {}),
        ...(payload.selection_v2 ? { selection_v2: true } : {}),
        ...(payload.research_profile ? { research_profile: payload.research_profile } : {}),
        ...(payload.execution_model ? { execution_model: payload.execution_model } : {}),
      },
      bars,
      120_000,
    )) as { portfolio?: SearchResult["portfolio"] }
    return res?.portfolio ?? null
  } catch {
    return null // 组合评估失败不影响冠军结果
  }
}

/** CPU 路径:多核并行(与超级因子挖掘同架构——JS 进化 + 分片池并行 f64
 * 评估 + 主实例单点严格筛;池不可用自动降级单进程)。评估/严格筛与 GPU
 * 路径同源同口径,对外数字全部出自内核 f64 */
async function searchStepwiseCpu(
  payload: LocalFactorPayload,
  bars: KlineBar[],
  onProgress?: (msg: string) => void,
  onStep?: (step: LocalSearchStep) => void,
): Promise<SearchResult> {
  const { CpuBackend } = await import("@/lib/mining/backends/cpu-backend")
  const backend = new CpuBackend()
  onProgress?.(
    "本地多核引擎启动中：初始化本地计算内核（组件已内置安装包，通常秒级；多 worker 并行加载期间安静属正常）…",
  )
  const gen = backend.runDirect(
    bars,
    {
      snapshotId: "direct",
      config: {
        symbol: payload.symbol,
        crypto_profile: payload.crypto_profile,
        timeframe: payload.timeframe,
        population: payload.population,
        generations: payload.generations,
        max_depth: payload.max_depth ?? 4,
        train_ratio: payload.train_ratio ?? 0,
        ...(payload.test_recent_bars != null ? { test_recent_bars: payload.test_recent_bars } : {}),
        walk_forward_folds: payload.walk_forward_folds ?? 0,
        top_n: payload.top_n,
        seed: payload.seed,
        cost: payload.cost ?? null,
        ...(payload.seed_tokens?.length ? { seed_tokens: payload.seed_tokens } : {}),
        ...(payload.selection_v2 ? { selection_v2: true } : {}),
        ...(payload.evolve_v2 ? { evolve_v2: true } : {}),
        ...(payload.live_entry_gate ? { live_entry_gate: payload.live_entry_gate } : {}),
        ...(payload.research_profile ? { research_profile: payload.research_profile } : {}),
        ...(payload.execution_model ? { execution_model: payload.execution_model } : {}),
        ...(payload.label_span != null ? { label_span: payload.label_span } : {}),
      },
      startGeneration: 0,
    },
    new AbortController().signal,
  )
  let champions: Champion[] = []
  while (true) {
    const r = await gen.next()
    if (r.done) {
      champions = r.value
      break
    }
    champions = r.value.champions
    onProgress?.(
      `第 ${r.value.generation}/${r.value.totalGenerations} 代 · 当前最优 ` +
        `${r.value.bestComposite.toFixed(2)}(多核并行,${bars.length} 根 K)`,
    )
    onStep?.({
      generation: r.value.generation,
      totalGenerations: r.value.totalGenerations,
      bestComposite: r.value.bestComposite,
      elapsedMs: r.value.elapsedMs,
      shardWorkers: r.value.gpuStats?.shardWorkers ?? 0,
      evaluated: r.value.gpuStats?.evaluated ?? 0,
      cacheHits: r.value.gpuStats?.cacheHits ?? 0,
      rankMs: r.value.gpuStats?.rankMs ?? 0,
      preciseMs: r.value.gpuStats?.preciseMs ?? 0,
      engine: "cpu",
    })
  }
  await stampKernelVersion(champions)
  const portfolio = await evaluatePortfolio(payload, bars, champions)
  return toSearchResult(payload, bars, champions, portfolio)
}

/** GPU 路径:WGSL 粗排 + Pyodide 精算(对外数字全部出自内核 f64) */
async function searchGpu(
  payload: LocalFactorPayload,
  bars: KlineBar[],
  onProgress?: (msg: string) => void,
  onStep?: (step: LocalSearchStep) => void,
): Promise<SearchResult> {
  const { GpuBackend } = await import("@/lib/mining/backends/gpu-backend")
  const backend = new GpuBackend()
  // 冷加载提示:首次运行需下载 Pyodide+numpy(主内核 + 精算分片 worker 并发,
  // 慢网下可达数分钟),期间 CPU/GPU 均安静属正常——没有这句用户会以为卡死
  onProgress?.(
    "GPU 引擎启动中：初始化本地计算内核（首次需下载组件，视网速约 1-5 分钟，期间 CPU/GPU 安静属正常；仅首次，之后常驻秒启）…",
  )
  const gen = backend.runDirect(
    bars,
    {
      snapshotId: "direct",
      config: {
        symbol: payload.symbol,
        crypto_profile: payload.crypto_profile,
        timeframe: payload.timeframe,
        population: payload.population,
        generations: payload.generations,
        max_depth: payload.max_depth ?? 4,
        train_ratio: payload.train_ratio ?? 0,
        ...(payload.test_recent_bars != null ? { test_recent_bars: payload.test_recent_bars } : {}),
        walk_forward_folds: payload.walk_forward_folds ?? 0,
        top_n: payload.top_n,
        seed: payload.seed,
        cost: payload.cost ?? null,
        ...(payload.seed_tokens?.length ? { seed_tokens: payload.seed_tokens } : {}),
        ...(payload.selection_v2 ? { selection_v2: true } : {}),
        ...(payload.evolve_v2 ? { evolve_v2: true } : {}),
        ...(payload.live_entry_gate ? { live_entry_gate: payload.live_entry_gate } : {}),
        ...(payload.research_profile ? { research_profile: payload.research_profile } : {}),
        ...(payload.execution_model ? { execution_model: payload.execution_model } : {}),
        ...(payload.label_span != null ? { label_span: payload.label_span } : {}),
      },
      startGeneration: 0,
    },
    new AbortController().signal,
  )
  let champions: Champion[] = []
  while (true) {
    const r = await gen.next()
    if (r.done) {
      champions = r.value
      break
    }
    champions = r.value.champions
    onProgress?.(
      `第 ${r.value.generation}/${r.value.totalGenerations} 代 · 当前最优 ` +
        `${r.value.bestComposite.toFixed(2)}(GPU 粗排 + 本地精算,${bars.length} 根 K)`,
    )
    onStep?.({
      generation: r.value.generation,
      totalGenerations: r.value.totalGenerations,
      bestComposite: r.value.bestComposite,
      elapsedMs: r.value.elapsedMs,
      shardWorkers: r.value.gpuStats?.shardWorkers ?? 0,
      evaluated: r.value.gpuStats?.evaluated ?? 0,
      cacheHits: r.value.gpuStats?.cacheHits ?? 0,
      rankMs: r.value.gpuStats?.rankMs ?? 0,
      preciseMs: r.value.gpuStats?.preciseMs ?? 0,
      engine: "gpu",
    })
  }
  await stampKernelVersion(champions)
  const portfolio = await evaluatePortfolio(payload, bars, champions)
  return toSearchResult(payload, bars, champions, portfolio)
}

export async function searchFactorsLocal(
  payload: LocalFactorPayload,
  onProgress?: (msg: string) => void,
  engine: LocalSearchEngine = "cpu",
  onStep?: (step: LocalSearchStep) => void,
): Promise<SearchResult> {
  payload = { ...payload, crypto_profile: payload.crypto_profile ?? isCryptoSymbol(payload.symbol) }
  onProgress?.("拉取 K 线数据…")
  // 深历史(start_date 默认 2005)在服务端修复连续合约回溯后可达,
  // 页数上限须覆盖 15m 全量(rb≈134 页),否则长区间被静默截断
  const bars = await fetchBacktestBars(
    payload.symbol,
    payload.timeframe,
    payload.start_date || (payload.data_channel === "gate_usdt" ? gateResearchRange(payload.timeframe).start : "2005-01-01"),
    payload.end_date || new Date().toISOString().slice(0, 10),
    KLINE_MAX_PAGES,
    undefined,
    onProgress,
    normalizeChannel(payload.data_channel),
  )
  if (bars.length < 60) throw new Error("该区间 K 线数据不足(至少 60 根)")
  // 冻结本次搜索的行情与口径:复测复用(方案任务 3 验收)
  lastSearchSnapshot = {
    key: snapshotKey(payload.symbol, payload.timeframe, payload.data_channel),
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    channel: payload.data_channel,
    bars,
    startDate: payload.start_date || (payload.data_channel === "gate_usdt" ? gateResearchRange(payload.timeframe).start : "2005-01-01"),
    endDate: payload.end_date || new Date().toISOString().slice(0, 10),
    cost: payload.cost ?? null,
    researchProfile: payload.research_profile,
  }
  if (engine === "gpu") {
    try {
      return await searchGpu(payload, bars, onProgress, onStep)
    } catch (e) {
      // GPU 不可用:回退 CPU 会话(静默降级并提示原因)
      const reason = e instanceof Error ? e.message : String(e)
      onProgress?.(`GPU 不可用(${reason}),已回退本地 CPU…`)
      return await searchStepwiseCpu(payload, bars, onProgress, onStep)
    }
  }
  return await searchStepwiseCpu(payload, bars, onProgress, onStep)
}

/** 单因子资金曲线回测(本地):与 /api/factor-lab/backtest-factor 同构。
 *
 * reuseSnapshot=true(默认)时复用最近一次搜索冻结的行情快照与成本口径
 * (方案任务 3 验收:搜索后网络原始数据被修订,复测仍复现原结果)。
 * 快照与请求的 symbol/timeframe/channel 不匹配,或显式传入了新的日期
 * 区间(用户改了表单)时,回退重新取数。
 */
export async function backtestFactorLocal(
  payload: {
    symbol: string
    timeframe: string
    factor_tokens: number[]
    crypto_profile?: boolean
    initial_cash?: number
    cost?: number | null
    walk_forward_folds?: number
    start_date?: string
    end_date?: string
    data_channel?: string
    /** v2 复测同口径:与搜索一致的因果归一化/缺失掩码 */
    research_profile?: string
  },
  onProgress?: (msg: string) => void,
  reuseSnapshot = true,
): Promise<FactorBacktestResult> {
  const snap = reuseSnapshot ? lastSearchSnapshot : null
  // 复用条件:symbol/timeframe/channel 一致,且请求区间与搜索取数区间相同
  // (用户改了日期区间 → 不复用,按新区间重新取数)
  const reqStart = payload.start_date || (payload.data_channel === "gate_usdt" ? gateResearchRange(payload.timeframe).start : "2005-01-01")
  const reqEnd = payload.end_date || new Date().toISOString().slice(0, 10)
  const snapUsable =
    snap !== null &&
    snap.key === snapshotKey(payload.symbol, payload.timeframe, payload.data_channel) &&
    snap.startDate === reqStart &&
    snap.endDate === reqEnd
  let bars: KlineBar[]
  let effectivePayload = payload
  if (snapUsable && snap) {
    bars = snap.bars // 冻结快照:不重新取数,复现搜索时口径
    // 成本优先级:调用方显式值 > 搜索时冻结值(不按当前末端价格重算)
    if (payload.cost == null && snap.cost != null) {
      effectivePayload = { ...payload, cost: snap.cost }
    }
    onProgress?.(`复用搜索快照(${bars.length} 根 K,冻结成本 ${snap.cost ?? "自动"})复测…`)
  } else {
    onProgress?.("拉取 K 线数据…")
    bars = await fetchBacktestBars(
      payload.symbol,
      payload.timeframe,
      payload.start_date || (payload.data_channel === "gate_usdt" ? gateResearchRange(payload.timeframe).start : "2005-01-01"),
      payload.end_date || new Date().toISOString().slice(0, 10),
      KLINE_MAX_PAGES,
      undefined,
      onProgress,
      normalizeChannel(payload.data_channel),
    )
  }
  if (bars.length < 30) throw new Error("该区间 K 线数据不足")
  onProgress?.("本地单因子回测…")
  const { ensurePyWorker } = await import("@/lib/py-worker")
  const result = (await ensurePyWorker().factorRun(
    { mode: "backtest_factor", ...effectivePayload } as unknown as Record<string, unknown>,
    bars,
  )) as FactorBacktestResult
  if (result && (result as { error?: string }).error) {
    throw new Error((result as { error?: string }).error)
  }
  return result
}
