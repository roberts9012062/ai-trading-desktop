import { gateResearchRange } from "@/lib/crypto-direct"
import { isCryptoSymbol, LOCAL_MINING_KERNEL_VERSION } from "./crypto-profile"
/**
 * LocalMiningRunner —— 本地 CPU 挖掘的任务编排(M3)
 *
 * 状态机(文档 2.5):pending → running →(pause/resume)→ paused;
 * 跑完全部代数 → completed;异常/数据不足 → failed;取消 → cancelled。
 *
 * - 并发上限 1:Pyodide worker 池是全局资源,多任务并行会互相饿死;
 *   后续任务排队 pending,由 #scheduleNext 依创建顺序补位;
 * - 每代持久化一次(current_generation/best_seen/当代 champions),
 *   应用崩溃或关闭后重开,pending/running 一律恢复为 paused 并写明原因,
 *   不自动续跑(避免一开应用就占满 CPU);
 * - 续训语义(决策记录 D-1,如实措辞):resume 从第 N 代继续,历史最优
 *   因子作为种子进入新种群——不是精确恢复演化轨迹,UI 文案不得宣称
 *   "精确断点续训/无损恢复";
 * - 共享 worker 意外中断(如被本地回测的「取消」terminate):会话已死但
 *   有进度,转 paused 可恢复,而非 failed。
 */

import type { Champion, PortfolioResult } from "@/lib/factor-lab-api"
import type { MiningRunner } from "./runner"
import type { DeviceKind, MiningConfig, MiningTask, RunnerKind } from "./types"
import { CpuBackend } from "./backends/cpu-backend"
import { GpuBackend } from "./backends/gpu-backend"
import { NativeRecoveryBackend } from "./backends/native-recovery-backend"
import { NativeRecoveryPaused } from "@/lib/native-engine/recovery"
import { NATIVE_ENGINE_TAG, NATIVE_ENGINE_VERSION } from "@/lib/native-engine/version"
import type { ComputeBackend } from "./backends/types"
import {
  acquireBarsSnapshot,
  getBarsSnapshot,
  reconcileSnapshotRefs,
  releaseBarsSnapshot,
} from "./data-source"
import { resolveDevice } from "./device"
import { defaultFactorRangeFor, factorMaxDaysFor } from "@/components/factor-lab/factor-range-limits"
import {
  deleteLocalTask,
  listLocalTasks,
  putLocalTask,
  toMiningTask,
  type LocalTaskRecord,
} from "./local-store"

const TERMINAL = new Set(["completed", "failed", "cancelled"])

function nowIso(): string {
  return new Date().toISOString()
}

let taskSeq = 0

export interface LocalRunnerOptions {
  /** 按任务实际算力构造后端;默认 CPU→CpuBackend、GPU→GpuBackend */
  backendFactory?: (device: "cpu" | "gpu" | "native-gpu", config?: MiningConfig) => ComputeBackend
}

export class LocalMiningRunner implements MiningRunner {
  readonly kind: RunnerKind = "local"

  #records = new Map<string, LocalTaskRecord>()
  #controllers = new Map<string, AbortController>()
  #runningId: string | null = null
  #listeners = new Set<(t: MiningTask) => void>()
  #bootPromise: Promise<void>
  #backendFactory: NonNullable<LocalRunnerOptions["backendFactory"]>

  constructor(opts: LocalRunnerOptions = {}) {
    this.#backendFactory =
      opts.backendFactory ?? ((d, config) => d === "native-gpu" ? new NativeRecoveryBackend({ precision: config?.native_precision }) : (d === "gpu" ? new GpuBackend() : new CpuBackend()))
    this.#bootPromise = this.#boot()
  }

  /** 启动恢复:加载持久化任务,重启前的 pending/running 转 paused */
  async #boot(): Promise<void> {
    let records: LocalTaskRecord[]
    try {
      records = await listLocalTasks()
    } catch {
      records = []
    }
    for (const r of records) {
      if (r.status === "pending" || r.status === "running") {
        r.status = "paused"
        r.pause_reason = "应用重启,已自动暂停,可手动恢复"
        r.updated_at = nowIso()
        await putLocalTask(r).catch(() => undefined)
      }
      this.#records.set(r.id, r)
      this.#emit(toMiningTask(r))
    }
    // 校准快照引用计数:崩溃泄漏的 refCount 会永远挡住 LRU 淘汰
    const active = [...this.#records.values()]
      .filter((r) => !TERMINAL.has(r.status))
      .map((r) => r.snapshotId)
    try {
      await reconcileSnapshotRefs(active)
    } catch {
      // 校准失败不阻塞启动
    }
  }

  async #ready(): Promise<void> {
    await this.#bootPromise
  }

  subscribe(cb: (t: MiningTask) => void): () => void {
    this.#listeners.add(cb)
    return () => {
      this.#listeners.delete(cb)
    }
  }

  #emit(t: MiningTask): void {
    for (const cb of this.#listeners) cb(t)
  }

  async create(
    config: MiningConfig,
    opts: { device: DeviceKind; name?: string; onProgress?: (msg: string) => void },
  ): Promise<MiningTask> {
    const progress = opts.onProgress
    await this.#ready()
    const isCrypto = config.crypto_profile ?? isCryptoSymbol(config.symbol)
    config = {
      ...config,
      kernel_version: opts.device === "native-gpu" ? NATIVE_ENGINE_TAG : LOCAL_MINING_KERNEL_VERSION,
      ...(opts.device === "native-gpu" ? { native_engine_version: NATIVE_ENGINE_VERSION } : {}),
      crypto_profile: isCrypto,
      // 加密币增强挖掘:启用 crypto_local_v2 研究契约(60/20/20 切分+严格因果归一化+
      // 可执行口径,见 factor_local.py);调用方显式指定 research_profile(如短线
      // shortline_v1)时必须尊重,不覆盖——覆盖会让短线任务的 v4 特征注入与
      // 页面任务过滤全部失效(只补默认,与原生引擎 session.py 的默认逻辑一致)
      ...(isCrypto && !config.research_profile && (config.selection_v2 || config.evolve_v2)
        ? { research_profile: "crypto_local_v2" }
        : {})
    }
    progress?.("检查本地算力（CPU/GPU）…")
    const resolution = await resolveDevice(opts.device)

    // 历史 K 线按渠道直连拉取并冻结为本地快照;区间缺省用该周期推荐区间
    const channelLabel = config.data_channel === "okx" ? "后端转发" : config.data_channel === "gate_usdt" || config.data_channel === "gate_spot" ? "Gate 直连" : "Binance 直连"
    const months = Math.max(1, Math.ceil(factorMaxDaysFor(config.timeframe) / 30))
    progress?.(`拉取 K 线（${channelLabel}，约 ${months} 个月归档包——国内链路 100-250KB/s，预计 ${months < 12 ? "1-5" : "3-10"} 分钟；本阶段无逐包进度，页面动画条在动即未卡死；同区间二次创建走缓存秒建`)
    const range = config.data_channel === "gate_usdt" ? gateResearchRange(config.timeframe) : defaultFactorRangeFor(config.timeframe, new Date())
    const snapshot = await acquireBarsSnapshot({
      symbol: config.symbol,
      timeframe: config.timeframe,
      channel: config.data_channel,
      startDate: config.start_date ?? range.start,
      endDate: config.end_date ?? range.end,
    })

    // 短线任务:冻结快照注入 v4 订单流特征列(digest 确定性派生;见 task-enrich)
    if (config.research_profile === "shortline_v1") {
      progress?.("注入 aggTrades 订单流特征列（v4 digest）…")
      const { patchBarsSnapshotColumns } = await import("@/lib/mining/data-source")
      const { enrichBarsWithOrderflow } = await import("@/lib/shortline/task-enrich")
      await patchBarsSnapshotColumns(snapshot.id, async (bars) => {
        const res = await enrichBarsWithOrderflow(
          bars, config.symbol, config.timeframe as "1m" | "5m" | "15m",
        )
        progress?.(
          `v4 特征列：覆盖 ${res.enrichedBars}/${snapshot.count} 根` +
            (res.digestSha ? `（digest ${res.digestSha.slice(0, 8)}…）` : "（digest 缺失,回填后可复跑）"),
        )
      })
    }

    const now = nowIso()
    taskSeq += 1
    const rec: LocalTaskRecord = {
      id: `local-${Date.now().toString(36)}-${taskSeq.toString(36)}`,
      name: opts.name ?? `本挖·${config.symbol}·${config.timeframe}`,
      config,
      deviceWanted: opts.device,
      effectiveDevice: resolution.device,
      degraded: resolution.degraded,
      status: "pending",
      current_generation: 0,
      progress_pct: 0,
      best_composite: 0,
      champions_count: 0,
      latest_champions: [],
      best_seen: [],
      snapshotId: snapshot.id,
      bars_count: snapshot.count,
      data_range_from: snapshot.from,
      data_range_to: snapshot.to,
      error_msg: null,
      pause_reason: null,
      elapsed_ms: 0,
      started_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    }
    await putLocalTask(rec)
    this.#records.set(rec.id, rec)
    this.#emit(toMiningTask(rec))
    this.#scheduleNext()
    return toMiningTask(rec)
  }

  async list(): Promise<MiningTask[]> {
    await this.#ready()
    return [...this.#records.values()].map(toMiningTask)
  }

  async get(id: string): Promise<MiningTask | null> {
    await this.#ready()
    const rec = this.#records.get(id)
    return rec ? toMiningTask(rec) : null
  }

  async champions(id: string): Promise<Champion[]> {
    await this.#ready()
    return this.#records.get(id)?.latest_champions ?? []
  }

  async pause(id: string): Promise<void> {
    await this.#ready()
    const rec = this.#records.get(id)
    if (!rec || TERMINAL.has(rec.status) || rec.status === "paused") return
    if (rec.status === "running") {
      // 代边界中止:当前这一代会算完,循环退出时保留 paused 状态与最新进度
      this.#controllers.get(id)?.abort()
    }
    rec.status = "paused"
    rec.pause_reason = null
    rec.updated_at = nowIso()
    await putLocalTask(rec)
    this.#emit(toMiningTask(rec))
  }

  async resume(id: string): Promise<void> {
    await this.#ready()
    const rec = this.#records.get(id)
    if (!rec || rec.status !== "paused") return
    if (rec.deviceWanted === "native-gpu" && rec.config.native_engine_version !== NATIVE_ENGINE_VERSION) {
      throw new Error("该任务使用旧版原生引擎，请新建任务，避免混用历史评分")
    }
    if (rec.deviceWanted !== "native-gpu" && rec.config.crypto_profile && rec.config.kernel_version !== LOCAL_MINING_KERNEL_VERSION) {
      throw new Error("该任务使用旧版加密挖掘内核，请新建任务，避免混用历史评分")
    }
    rec.status = "pending"
    rec.pause_reason = null
    rec.updated_at = nowIso()
    await putLocalTask(rec)
    this.#emit(toMiningTask(rec))
    this.#scheduleNext()
  }

  async cancel(id: string): Promise<void> {
    await this.#ready()
    const rec = this.#records.get(id)
    if (!rec || TERMINAL.has(rec.status)) return
    if (rec.status === "running") this.#controllers.get(id)?.abort()
    rec.status = "cancelled"
    rec.updated_at = nowIso()
    await putLocalTask(rec)
    this.#emit(toMiningTask(rec))
  }

  async remove(id: string): Promise<void> {
    await this.#ready()
    const rec = this.#records.get(id)
    if (!rec) return
    if (rec.status === "running") {
      rec.status = "cancelled"
      this.#controllers.get(id)?.abort()
    }
    await deleteLocalTask(id)
    this.#records.delete(id)
    try {
      await releaseBarsSnapshot(rec.snapshotId)
    } catch {
      // 快照可能已被 LRU 清理
    }
    this.#scheduleNext()
  }

  /** 空闲时按创建顺序补位下一个 pending(本机同时只跑 1 个任务) */
  #scheduleNext(): void {
    if (this.#runningId != null) return
    const next = [...this.#records.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0]
    if (!next) return
    this.#runningId = next.id
    next.status = "running"
    next.started_at = next.started_at ?? nowIso()
    next.updated_at = nowIso()
    void putLocalTask(next).catch(() => undefined)
    this.#emit(toMiningTask(next))
    void this.#runLoop(next.id)
  }

  /** 冠军组合评估(mine_portfolio 内核模式;<2 个冠军或失败返回 null) */
  async #evalPortfolio(rec: LocalTaskRecord): Promise<PortfolioResult | null> {
    if (rec.actualEngine === "native-gpu") return rec.portfolio ?? null
    if (rec.latest_champions.length < 2) return null
    try {
      const snapshot = await getBarsSnapshot(rec.snapshotId)
      if (!snapshot) return null
      const { ensurePyWorker } = await import("@/lib/py-worker")
      const res = (await ensurePyWorker().factorRun(
        {
          mode: "mine_portfolio",
          crypto_profile: rec.config.crypto_profile ?? false,
          symbol: rec.config.symbol,
          timeframe: rec.config.timeframe,
          cost: rec.config.cost ?? null,
          tokens_list: rec.latest_champions.map((c) => c.tokens),
          // 只在样本外段评估(冠军在训练段挑出,全段组合指标含样本内虚高);
          // 增强遴选时只用封存段
          train_ratio: rec.config.train_ratio,
          ...(rec.config.test_recent_bars != null ? { test_recent_bars: rec.config.test_recent_bars } : {}),
          ...(rec.config.selection_v2 ? { selection_v2: true } : {}),
        },
        snapshot.bars,
        120_000,
      )) as { portfolio?: PortfolioResult | null }
      return res?.portfolio ?? null
    } catch {
      return null
    }
  }

  async #runLoop(id: string): Promise<void> {
    const rec = this.#records.get(id)
    if (!rec) return
    const startGen = rec.current_generation
    let hadProgress = false
    const controller = new AbortController()
    this.#controllers.set(id, controller)
    const native = rec.deviceWanted === "native-gpu"
    const backend = native ? this.#backendFactory("native-gpu", rec.config) : this.#backendFactory(rec.effectiveDevice)
    if (backend instanceof NativeRecoveryBackend) backend.setStageHandler(message => {
      if (rec.status === "running") { rec.nativePhase = message; this.#emit(toMiningTask(rec)) }
    })
    // 冷启动 JIT 期间 stage 通道尚未建立(连接成功后才上报),先给出与因子
    // 实验室一致的启动预期,避免几分钟静默被误判为"没有运行"。
    if (native && rec.status === "running") {
      rec.nativePhase = rec.config.native_precision === "f64"
        ? "原生 GPU（Float64 严格模式）启动中：正在验证 CUDA 和 20 条确定性自检，首次编译约需 3–6 分钟，期间 CPU 满载属正常…"
        : "原生 GPU 启动中：正在验证 CUDA 和 20 条确定性自检，首次编译约需 2–4 分钟…"
      this.#emit(toMiningTask(rec))
    }
    if (backend instanceof NativeRecoveryBackend) backend.setRecoveryHandler(async state => {
      if ((rec.actualEngine ?? "native-gpu") !== state.engine) {
        rec.latest_champions = []; rec.champions_count = 0; rec.portfolio = null
        rec.engineTag = undefined; rec.engineVersion = undefined
      }
      rec.nativeRestarts = state.restarts
      rec.actualEngine = state.engine
      rec.pause_reason = state.reason
      rec.updated_at = nowIso()
      await putLocalTask(rec)
      this.#emit(toMiningTask(rec))
    })
    try {
      const gen = backend.run(
        {
          snapshotId: rec.snapshotId,
          config: rec.config,
          startGeneration: startGen,
          ...(rec.best_seen.length ? { seedBest: rec.best_seen } : {}),
          ...(native ? { nativeRestarts: rec.nativeRestarts, actualEngine: rec.actualEngine } : {}),
        },
        controller.signal,
      )
      while (true) {
        const res = await gen.next()
        if (res.done) break
        hadProgress = true
        const step = res.value
        rec.current_generation = step.generation
        rec.progress_pct = Math.min(
          100,
          Math.round((step.generation / Math.max(1, step.totalGenerations)) * 100),
        )
        rec.best_composite = step.bestComposite
        rec.latest_champions = step.champions
        // 续训种子:截至本代的去重 top-N 摘要(D-1 语义)
        rec.best_seen = (native && step.bestSeen) ? step.bestSeen : step.champions.map((c) => ({
          composite: c.composite,
          tokens: c.tokens,
          metrics: c.metrics as unknown as Record<string, unknown>,
        }))
        rec.champions_count = step.champions.length
        if (native) {
          rec.engineTag = step.engineTag; rec.engineVersion = step.engineVersion
          rec.actualEngine = step.actualEngine ?? "native-gpu"
          rec.effectiveDevice = rec.actualEngine === "cpu" ? "cpu" : "gpu"
          rec.nativeRestarts = step.nativeRestarts ?? rec.nativeRestarts
          rec.qualificationCounts = step.qualificationCounts
          rec.qualificationReasons = step.qualificationReasons
          rec.nativePhase = null
          if (step.actualEngine === "native-gpu") rec.portfolio = step.nativePortfolio ?? null
          rec.pause_reason = step.recoveryReason ?? null
        }
        rec.elapsed_ms += step.elapsedMs
        // GPU 活动统计(每代覆盖,UI 详情面板消费)
        if (step.gpuStats) rec.gpu_stats = step.gpuStats
        rec.updated_at = nowIso()
        await putLocalTask(rec)
        this.#emit(toMiningTask(rec))
      }
      // 迭代结束:正常完成,或 pause()/cancel() 触发的代边界中止
      rec.updated_at = nowIso()
      if (rec.status === "running") {
        rec.status = "completed"
        if (native) rec.nativePhase = null
        rec.progress_pct = 100
        rec.completed_at = nowIso()
        // 深挖强化 M4:完成时对冠军做组合评估(等权/IC 加权 vs 最优单因子;
        // best-effort,失败不阻断完成)
        rec.portfolio = await this.#evalPortfolio(rec)
      }
      await putLocalTask(rec)
      this.#emit(toMiningTask(rec))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (rec.status === "running") {
        if (hadProgress || (native && e instanceof NativeRecoveryPaused)) {
          // 中途断掉(如共享 worker 被 terminate):有进度,转暂停可恢复
          rec.status = "paused"
          rec.pause_reason = `本地计算中断(${msg}),已自动暂停,可手动恢复`
          if (e instanceof NativeRecoveryPaused) rec.nativeRestarts = e.restarts
        } else {
          // 一开始就失败(快照失效/参数非法等):failed
          rec.status = "failed"
          rec.error_msg = msg
          rec.completed_at = nowIso()
        }
        rec.updated_at = nowIso()
        await putLocalTask(rec).catch(() => undefined)
        this.#emit(toMiningTask(rec))
      }
    } finally {
      this.#controllers.delete(id)
      await backend.dispose().catch(() => undefined)
      if (this.#runningId === id) {
        this.#runningId = null
        this.#scheduleNext()
      }
    }
  }
}
