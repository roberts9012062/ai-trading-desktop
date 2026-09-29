/**
 * FactorLabSearchRunner —— 因子实验室搜索的后台任务编排
 *
 * 与超级因子的 LocalMiningRunner 同款语义,但为因子实验室独立实现
 * (互不影响):module 级单例,页面切走/回来搜索不断,进度经 subscribe
 * 推送;暂停/停止落在代边界(同步 Python 无法中途打断,D-1 如实措辞:
 * 恢复=从第 N 代继续、历史最优作种子,不是精确恢复演化轨迹)。
 *
 * - 并发 1:同一时刻只跑一个搜索(与旧一次性搜索一致),新搜索须先停旧;
 * - bars 在 start 时取一次并冻结在任务内,暂停/恢复复用同一份;
 * - 完成后 best-effort 落服务端历史(端点未上线静默降级),冠军留在
 *   任务里供页面回来后采纳展示;
 * - GPU 失败自动回退 CPU 从当前代继续(引擎字段随任务更新)。
 */

import type { Champion, SearchResult } from "@/lib/factor-lab-api"
import { saveFactorHistory } from "@/lib/factor-lab-api"
import type { SearchFormPayload } from "@/components/factor-lab/factor-search-form"
import {
  buildSearchConfig,
  createSearchBackend,
  finalizeSearchResult,
  prepareSearchBars,
  toLocalSearchStep,
  type LocalFactorPayload,
  type LocalSearchEngine,
  type LocalSearchStep,
} from "@/lib/local-factor"
import { isCryptoSymbol } from "@/lib/mining/crypto-profile"
import type { KlineBar } from "@/types"
import type { SerializedBest } from "./backends/types"
import { NativeRecoveryPaused } from "@/lib/native-engine/recovery"
import { NATIVE_ENGINE_VERSION } from "@/lib/native-engine/version"

export type FactorSearchStatus =
  | "fetching"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed"

export interface FactorSearchTask {
  nativePortfolio?: SearchResult["portfolio"]
  nativeRequested?: boolean
  nativeRestarts?: number
  nativeEngineVersion?: string
  bestSeen?: SerializedBest[]
  id: string
  status: FactorSearchStatus
  /** 提交时的搜索载荷(历史落库/结果采纳/恢复重跑用) */
  payload: LocalFactorPayload
  /** 提交时的表单原文(结果采纳时还原 lastReq;来自页面时非空) */
  form: SearchFormPayload | null
  engine: LocalSearchEngine
  generation: number
  totalGenerations: number
  bestComposite: number
  elapsedMs: number
  bars: number
  champions: Champion[]
  /** 最近一代的结构化进度(进度卡片消费;未开始为 null) */
  lastStep: LocalSearchStep | null
  /** 完成时的完整搜索结果(页面采纳用;未完成为 null) */
  result: SearchResult | null
  startedAt: number
  updatedAt: number
  error: string | null
  /** 阶段文案(取数/引擎启动/降级原因;跑起来后由代进度接管) */
  phase: string | null
}

type Listener = (t: FactorSearchTask | null) => void

const TERMINAL = new Set<FactorSearchStatus>(["completed", "cancelled", "failed"])

let seq = 0

export class FactorLabSearchRunner {
  #task: FactorSearchTask | null = null
  #bars: KlineBar[] | null = null
  #controller: AbortController | null = null
  #listeners = new Set<Listener>()
  #nativePending: Promise<void> | null = null
  constructor(private options: { prepareNativeBars?: typeof prepareSearchBars } = {}) {}

  get current(): FactorSearchTask | null {
    return this.#task
  }

  subscribe(cb: Listener): () => void {
    this.#listeners.add(cb)
    return () => {
      this.#listeners.delete(cb)
    }
  }

  #emit(): void {
    const t = this.#task
    for (const cb of this.#listeners) cb(t ? { ...t } : null)
  }

  #patch(p: Partial<FactorSearchTask>): void {
    if (!this.#task) return
    Object.assign(this.#task, p, { updatedAt: Date.now() })
    this.#emit()
  }

  /** 是否允许发起新搜索(旧任务终态或无任务) */
  canStart(): boolean {
    return this.#task === null || TERMINAL.has(this.#task.status)
  }

  async start(
    payload: LocalFactorPayload,
    engine: LocalSearchEngine,
    form: SearchFormPayload | null = null,
  ): Promise<void> {
    if (!this.canStart()) {
      throw new Error("已有搜索在后台运行，请先暂停或停止")
    }
    payload = { ...payload, crypto_profile: payload.crypto_profile ?? isCryptoSymbol(payload.symbol) }
    seq += 1
    const id = `fl-search-${Date.now().toString(36)}-${seq}`
    this.#bars = null
    this.#controller = new AbortController()
    this.#task = {
      id,
      status: "fetching",
      payload: { ...payload },
      form,
      engine,
      ...(engine === "native-gpu" ? { nativeRequested: true, nativeRestarts: 0,
        nativeEngineVersion: NATIVE_ENGINE_VERSION, bestSeen: [] } : {}),
      generation: 0,
      totalGenerations: payload.generations,
      bestComposite: 0,
      elapsedMs: 0,
      bars: 0,
      champions: [],
      lastStep: null,
      result: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      phase: "拉取 K 线数据…",
    }
    this.#emit()
    if (engine === "native-gpu") {
      const pending = this.#dispatch(id)
      this.#nativePending = pending
      try { await pending } finally { if (this.#nativePending === pending) this.#nativePending = null }
    } else await this.#dispatch(id)
  }

  /** 代边界暂停:当前这代会算完,之后停在已完成代数上 */
  pause(): void {
    if (this.#task?.status === "running" || this.#task?.status === "fetching") {
      this.#controller?.abort()
      this.#patch({ status: "paused", phase: "已暂停（当前代算完后停止，可继续）" })
    }
  }

  /** 恢复:从第 N 代继续,历史最优作为种子进入新种群(D-1 语义) */
  async resume(): Promise<void> {
    const t = this.#task
    if (!t || t.status !== "paused") return
    if (t.nativeRequested) {
      await this.#nativePending
      if (this.#task !== t || t.status !== "paused") return
      if (t.nativeEngineVersion !== NATIVE_ENGINE_VERSION) throw new Error("原生引擎版本已改变，请新建任务")
    }
    this.#controller = new AbortController()
    this.#patch({ status: "running", phase: null })
    if (t.nativeRequested) {
      const pending = this.#dispatch(t.id)
      this.#nativePending = pending
      try { await pending } finally { if (this.#nativePending === pending) this.#nativePending = null }
    } else await this.#dispatch(t.id)
  }

  /** 停止:代边界中止并定格为 cancelled(保留已完成代的最优,不再继续) */
  stop(): void {
    if (!this.#task || TERMINAL.has(this.#task.status)) return
    this.#controller?.abort()
    this.#patch({ status: "cancelled", phase: null })
  }

  /** 引擎调度:GPU 失败回退 CPU 从当前代重跑一次,其余异常按状态归档 */
  async #dispatch(id: string): Promise<void> {
    while (this.#task && this.#task.id === id) {
      const controller = this.#controller!
      try {
        await this.#enginePass(id, controller)
        return
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (this.#task.nativeRequested) {
          if (!controller.signal.aborted && !TERMINAL.has(this.#task.status)) {
            this.#patch(e instanceof NativeRecoveryPaused
              ? { status: "paused", nativeRestarts: e.restarts, error: null, phase: msg }
              : { status: "failed", error: msg, phase: null })
          }
          return
        }
        const paused = this.#task.status === "paused"
        if (
          this.#task.engine === "gpu" &&
          !paused &&
          !controller.signal.aborted &&
          !TERMINAL.has(this.#task.status)
        ) {
          this.#patch({
            engine: "cpu",
            phase: `GPU 不可用（${msg.slice(0, 120)}），已回退本地 CPU 从第 ${this.#task.generation} 代继续…`,
          })
          continue // #enginePass 按 task.engine 重新构造 CPU 后端续跑
        }
        if (this.#task.status === "running" || this.#task.status === "fetching") {
          this.#patch({ status: "failed", error: msg, phase: null })
        }
        return
      }
    }
  }

  /** 一轮引擎执行:取数(首次)→ 分代循环 → 收尾。代边界检查 pause/stop */
  async #enginePass(id: string, controller: AbortController): Promise<void> {
    const task = this.#task
    if (!task || task.id !== id) return

    if (this.#bars === null) {
      const prepare = task.nativeRequested ? this.options.prepareNativeBars ?? prepareSearchBars : prepareSearchBars
      const bars = await prepare(task.payload, (msg) => this.#patch({ phase: msg }))
      if (controller.signal.aborted || this.#task !== task) return
      this.#bars = bars
      this.#patch({ bars: bars.length })
    }
    const bars = this.#bars
    // 引擎取任务当前值(GPU 失败回退时 #patch 已把同一任务对象的 engine 改为 cpu)
    const engine: LocalSearchEngine = task.engine
    const native = task.nativeRequested === true
    const backend = await createSearchBackend(native ? "native-gpu" : engine, native ? {
      precision: task.payload.native_precision,
      onStage: message => { if (this.#task === task && !controller.signal.aborted) this.#patch({ phase: message }) },
      onRecovery: state => {
        if (this.#task === task) this.#patch({ nativeRestarts: state.restarts, engine: state.engine, phase: state.reason,
          ...(task.engine !== state.engine ? { champions: [], lastStep: null, nativePortfolio: null } : {}) })
      },
    } : undefined)
    this.#patch({
      status: task.status === "fetching" ? "running" : this.#task!.status,
      phase:
        native ? (task.payload.native_precision === "f64"
          ? "原生 GPU（Float64 严格模式）启动中：正在验证 CUDA 和 20 条确定性自检，首次编译约需 3–6 分钟，期间 CPU 满载属正常…"
          : "原生 GPU 启动中：正在验证 CUDA 和 20 条确定性自检，首次编译约需 2–4 分钟…") : engine === "gpu"
          ? "GPU 引擎启动中：初始化本地计算内核（组件已内置安装包；多 worker 并行加载期间安静属正常）…"
          : "本地多核引擎启动中：初始化本地计算内核（组件已内置安装包，通常秒级；多 worker 并行加载期间安静属正常）…",
    })

    const seedBest = native ? task.bestSeen : task.champions.length
      ? task.champions.map((c) => ({
          composite: c.composite,
          tokens: c.tokens,
          metrics: c.metrics as unknown as Record<string, unknown>,
        }))
      : undefined
    const gen = backend.runDirect(
      bars,
      {
        snapshotId: "direct",
        config: buildSearchConfig(task.payload),
        startGeneration: task.generation,
        ...(seedBest ? { seedBest } : {}),
        ...(native ? { nativeRestarts: task.nativeRestarts, actualEngine: task.engine } : {}),
      },
      controller.signal,
    )

    let champions: Champion[] = task.champions
    let elapsedBase = task.elapsedMs
    try {
    while (true) {
      const r = await gen.next()
      if (r.done) {
        champions = r.value
        break
      }
      champions = r.value.champions
      if (native && this.#task !== task) return
      const step = toLocalSearchStep(r.value, native ? "native-gpu" : engine)
      elapsedBase += step.elapsedMs
      // 暂停/停止落在代边界:pause()/stop() 已把状态置好,本代 patch 只记录
      // 进度(代数/最优/耗时),不得把状态强制拉回 running(否则 resume 静默失效)
      const st = this.#task?.status
      this.#patch({
        ...(st === "running" || st === "fetching" ? { status: "running" as const } : {}),
        generation: step.generation,
        totalGenerations: step.totalGenerations,
        bestComposite: step.bestComposite,
        elapsedMs: elapsedBase,
        champions,
        ...(native ? { bestSeen: r.value.bestSeen, nativeRestarts: r.value.nativeRestarts,
          engine: r.value.actualEngine ?? task.engine, nativePortfolio: r.value.nativePortfolio } : {}),
        lastStep: step,
        phase: native
          ? `第 ${step.generation}/${step.totalGenerations} 代 · 合格 ${champions.length} · ${step.engine === "native-gpu" ? `${step.shardWorkers} SM` : step.engine === "gpu" ? "WebGPU" : "CPU 多核"}，${bars.length} 根 K`
          : `第 ${step.generation}/${step.totalGenerations} 代 · 当前最优 ${step.bestComposite.toFixed(2)}（${step.shardWorkers > 0 ? `${step.shardWorkers} 核并行` : "单进程"}，${bars.length} 根 K）`,
      })
      if (controller.signal.aborted) {
        // pause()/stop() 在代边界触发:进度已保留,状态由调用方置好
        return
      }
    }
    if (native && controller.signal.aborted) return
    if (this.#task !== task || TERMINAL.has(this.#task.status)) return
    this.#patch({ phase: "冠军组合评估…", champions })
    const result = await finalizeSearchResult(task.payload, bars, champions, native ? task.engine : undefined, task.nativePortfolio)
    if (this.#task !== task || TERMINAL.has(this.#task.status)) return
    this.#patch({ status: "completed", result, champions: result.champions, phase: null })
    void this.#persistHistory(task.payload, result)
    } finally {
      if (native) {
        await gen.return([]).catch(() => undefined)
        await backend.dispose().catch(() => undefined)
      }
    }
  }

  /** 完成后 best-effort 落服务端历史(404/网络失败静默跳过) */
  async #persistHistory(p: LocalFactorPayload, r: SearchResult): Promise<void> {
    if (!r.champions.length) return
    try {
      await saveFactorHistory({
        symbol: p.symbol,
        timeframe: p.timeframe,
        champions: r.champions.slice(0, 20).map((c) => ({
          tokens: c.tokens,
          text: c.text,
          composite: c.composite,
          metrics: c.metrics,
        })),
        trials: p.population * p.generations + (p.seed_tokens?.length ?? 0),
        bars: r.bars,
        config: {
          data_channel: p.data_channel,
          population: p.population,
          generations: p.generations,
          train_ratio: p.train_ratio,
          test_recent_bars: p.test_recent_bars,
          walk_forward_folds: p.walk_forward_folds,
          cost: p.cost,
          seed: p.seed,
          seed_count: p.seed_tokens?.length ?? 0,
          start_date: p.start_date ?? null,
          end_date: p.end_date ?? null,
        },
      })
    } catch {
      // 静默降级:历史面板只是少了本条,搜索本身已成功
    }
  }
}

/** 模块级单例:页面切走/回来存活(SPA 内常驻),后台持续挖掘 */
export const factorLabRunner = new FactorLabSearchRunner()
