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
  start_date?: string
  end_date?: string
}

export type LocalSearchEngine = "cpu" | "gpu"

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
      },
      bars,
      120_000,
    )) as { portfolio?: SearchResult["portfolio"] }
    return res?.portfolio ?? null
  } catch {
    return null // 组合评估失败不影响冠军结果
  }
}

/** CPU 路径:分代会话逐代推进(真实进度;结果与一次性 search 逐位一致) */
async function searchStepwiseCpu(
  payload: LocalFactorPayload,
  bars: KlineBar[],
  onProgress?: (msg: string) => void,
): Promise<SearchResult> {
  onProgress?.("本地 GP 搜索中（首次需下载 numpy ~10MB，视网速约 1-2 分钟，期间安静属正常；仅首次，之后常驻秒启）…")
  const { ensurePyWorker } = await import("@/lib/py-worker")
  const py = ensurePyWorker()
  const sessionId = `fl-${Date.now().toString(36)}`
  const start = (await py.mineStart(
    { ...payload, session_id: sessionId, start_generation: 0 },
    bars,
  )) as { session_id?: string }
  const sid = start?.session_id ?? sessionId
  let champions: Champion[] = []
  try {
    while (true) {
      const step = (await py.mineStep(sid)) as MineStepResult
      if (step && step.error) throw new Error(step.error)
      if (!step || step.done) break
      champions = step.champions ?? []
      onProgress?.(
        `第 ${step.generation}/${step.total_generations} 代 · 当前最优 ` +
          `${Number(step.best_composite ?? 0).toFixed(2)}(${bars.length} 根 K)`,
      )
    }
  } finally {
    await py.mineDispose(sid).catch(() => undefined)
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
  }
  await stampKernelVersion(champions)
  const portfolio = await evaluatePortfolio(payload, bars, champions)
  return toSearchResult(payload, bars, champions, portfolio)
}

export async function searchFactorsLocal(
  payload: LocalFactorPayload,
  onProgress?: (msg: string) => void,
  engine: LocalSearchEngine = "cpu",
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
  if (engine === "gpu") {
    try {
      return await searchGpu(payload, bars, onProgress)
    } catch (e) {
      // GPU 不可用:回退 CPU 会话(静默降级并提示原因)
      const reason = e instanceof Error ? e.message : String(e)
      onProgress?.(`GPU 不可用(${reason}),已回退本地 CPU…`)
      return await searchStepwiseCpu(payload, bars, onProgress)
    }
  }
  return await searchStepwiseCpu(payload, bars, onProgress)
}

/** 单因子资金曲线回测(本地):与 /api/factor-lab/backtest-factor 同构 */
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
  },
  onProgress?: (msg: string) => void,
): Promise<FactorBacktestResult> {
  onProgress?.("拉取 K 线数据…")
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
  if (bars.length < 30) throw new Error("该区间 K 线数据不足")
  onProgress?.("本地单因子回测…")
  const { ensurePyWorker } = await import("@/lib/py-worker")
  const result = (await ensurePyWorker().factorRun(
    { mode: "backtest_factor", ...payload } as unknown as Record<string, unknown>,
    bars,
  )) as FactorBacktestResult
  if (result && (result as { error?: string }).error) {
    throw new Error((result as { error?: string }).error)
  }
  return result
}
