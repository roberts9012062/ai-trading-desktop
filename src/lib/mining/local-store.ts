/**
 * 本地挖掘任务持久化(M3) —— IndexedDB store `mining-tasks`(keyPath "id")
 *
 * 持久化时机:每完成一代(收到 worker 的 step)写一次,应用崩溃/关闭后
 * 重开可从 current_generation + best_seen 恢续(续训语义见决策记录 D-1)。
 */

import type { Champion, PortfolioResult } from "@/lib/factor-lab-api"
import { openDb, idbGet, idbPut, idbGetAll, idbDelete, MINING_TASKS_STORE } from "@/lib/idb"
import type { DeviceKind, MiningConfig, MiningTask } from "./types"
import type { SerializedBest } from "./backends/types"

export type LocalTaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

/** 本地任务持久化记录(内部字段不进对外 MiningTask 视图) */
export interface LocalTaskRecord {
  id: string
  name: string
  config: MiningConfig
  /** 用户选择的算力(auto/cpu/gpu;gpu 未上线时 effectiveDevice 落 cpu) */
  deviceWanted: DeviceKind
  effectiveDevice: "cpu" | "gpu"
  degraded: boolean
  status: LocalTaskStatus
  current_generation: number
  progress_pct: number
  best_composite: number
  champions_count: number
  latest_champions: Champion[]
  /** 续训种子:截至最近一代的去重 top-N 摘要 */
  best_seen: SerializedBest[]
  snapshotId: string
  bars_count: number
  data_range_from: string | null
  data_range_to: string | null
  error_msg: string | null
  pause_reason: string | null
  /** 累计计算用时与代数(ETA 用,M5 展示) */
  elapsed_ms: number
  /** 冠军组合评估(完成时产出;深挖强化 M4,等权/IC 加权 vs 最优单因子) */
  portfolio?: PortfolioResult | null
  /** 最近一代 GPU 活动统计(粗排吞吐/缓存/显存/精算并行;GPU 任务) */
  gpu_stats?: import("./backends/types").GpuStepStats
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export function toMiningTask(r: LocalTaskRecord): MiningTask {
  return {
    id: r.id,
    origin: "local",
    device: r.deviceWanted,
    effectiveDevice: r.effectiveDevice,
    name: r.name,
    symbol: r.config.symbol,
    timeframe: r.config.timeframe,
    population: r.config.population,
    generations: r.config.generations,
    max_depth: r.config.max_depth,
    train_ratio: r.config.train_ratio,
    walk_forward_folds: r.config.walk_forward_folds,
    status: r.status,
    pause_reason: r.pause_reason,
    current_generation: r.current_generation,
    best_composite: r.best_composite,
    progress_pct: r.progress_pct,
    champions_count: r.champions_count,
    bars_count: r.bars_count,
    data_range_from: r.data_range_from,
    data_range_to: r.data_range_to,
    error_msg: r.error_msg,
    started_at: r.started_at,
    completed_at: r.completed_at,
    updated_at: r.updated_at,
    created_at: r.created_at,
    snapshotId: r.snapshotId,
    config: r.config,
    elapsed_ms: r.elapsed_ms,
    portfolio: r.portfolio ?? null,
    gpu_stats: r.gpu_stats ?? null,
  }
}

export async function getLocalTask(id: string): Promise<LocalTaskRecord | null> {
  const db = await openDb()
  if (!db) return null
  const rec = await idbGet<LocalTaskRecord | undefined>(db, MINING_TASKS_STORE, id)
  return rec ?? null
}

export async function putLocalTask(rec: LocalTaskRecord): Promise<void> {
  const db = await openDb()
  if (!db) throw new Error("IndexedDB 不可用,无法保存本地挖掘任务")
  await idbPut(db, MINING_TASKS_STORE, rec)
}

export async function listLocalTasks(): Promise<LocalTaskRecord[]> {
  const db = await openDb()
  if (!db) return []
  return idbGetAll<LocalTaskRecord>(db, MINING_TASKS_STORE)
}

export async function deleteLocalTask(id: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  await idbDelete(db, MINING_TASKS_STORE, id)
}
