/**
 * ComputeBackend 接口(M3) —— 本地挖掘的算力抽象
 *
 * run() 用 AsyncGenerator:每完成一代 yield 一次,取消点天然落在代边界,
 * 与内核 search_stepwise 的 yield 语义一一对应。GPU 后端(M4)实现同一
 * 接口:WGSL 粗排 + Pyodide f64 精算;对外暴露的数字一律出自 f64 内核。
 */

import type { Champion } from "@/lib/factor-lab-api"
import type { MiningConfig } from "../types"

/** 断点续训注入的历史最优摘要(D-1:作为种子进入新种群,非精确恢复) */
export interface SerializedBest {
  composite: number
  tokens: number[]
  metrics: Record<string, unknown>
}

export interface EvalRequest {
  snapshotId: string
  config: MiningConfig
  startGeneration: number
  seedBest?: SerializedBest[]
  nativeRestarts?: number
  actualEngine?: "cpu" | "gpu" | "native-gpu"
}

/** GPU 路径的代级活动统计(「GPU 在干活」的可见证据;local-runner 透传到 UI) */
export interface GpuStepStats {
  /** 本代粗排耗时 ms(GPU dispatch,含读回) */
  rankMs: number
  /** 本代评估候选数(整个种群) */
  evaluated: number
  /** 其中粗排缓存命中数(未上 GPU) */
  cacheHits: number
  /** 实际提交 GPU 的唯一候选数(非硬件利用率) */
  gpuEvaluated?: number
  /** f64 精算墙钟时间;可与下一代粗排重叠 */
  preciseMs?: number
  /** 批缓冲估算显存 MB(tile×栈层×T + factor + 特征矩阵) */
  gpuMemMB: number
  /** 精算分片 worker 数;0=主实例串行(池不可用/降级) */
  shardWorkers: number
}

export interface GenerationStep {
  nativePortfolio?: import("@/lib/factor-lab-api").PortfolioResult | null
  /** 已完成代数(1-based) */
  generation: number
  totalGenerations: number
  bestComposite: number
  /** 截至本代的去重 top-N(最终代即正式结果) */
  champions: Champion[]
  /** 本代耗时(ms) */
  elapsedMs: number
  /** GPU 路径才有:粗排吞吐/缓存/显存/精算并行度 */
  gpuStats?: GpuStepStats
  engineTag?: string
  engineVersion?: string
  actualEngine?: "cpu" | "gpu" | "native-gpu"
  bestSeen?: SerializedBest[]
  nativeRestarts?: number
  qualificationCounts?: { research: number; qualified: number; pending: number; rejected: number }
  qualificationReasons?: string[]
  recoveryReason?: string
}

export interface ComputeBackend {
  readonly device: "cpu" | "gpu"
  /** 探测可用性;不可用返回原因(用于 UI 置灰 tooltip) */
  probe(): Promise<{ available: boolean; reason?: string; detail?: string }>
  /** 分代步进执行;调用方可在 yield 之间通过 signal 取消 */
  run(req: EvalRequest, signal: AbortSignal): AsyncGenerator<GenerationStep, Champion[], void>
  dispose(): Promise<void>
}
