/**
 * RemoteMiningRunner —— 包装现有 super-factor-api,适配 MiningRunner 接口
 *
 * 范围约束(硬性):服务端挖掘一律 CPU。create() 的 device 恒发 "cpu",
 * 即使调用方误传 gpu 也强制改写——GPU 只存在于客户端,后端没有也不该有
 * GPU 语义。
 *
 * subscribe:内部自适应轮询(有活跃任务 5s,否则 30s)转为逐任务事件;
 * 递归 setTimeout 保证上一次请求完成后再排下一次,慢请求不会堆叠。
 */

import {
  POLL_INTERVAL_MS,
  cancelTask,
  createTask,
  deleteTask,
  getChampions,
  getTask,
  listTasks,
  pauseTask,
  resumeTask,
  type MiningTask as ServerMiningTask,
} from "@/lib/super-factor-api"
import type { Champion } from "@/lib/factor-lab-api"
import type { DeviceKind, MiningConfig, MiningTask, RunnerKind } from "./types"
import type { MiningRunner } from "./runner"

const IDLE_POLL_MS = 30_000

/** 服务端 DTO → 统一类型:origin=remote;device 收敛为 "server"
 *  (服务端一律 CPU,UI 服务器行恒显示 CPU 标签) */
function toUnified(t: ServerMiningTask): MiningTask {
  return { ...t, origin: "remote" as const, device: "server" as const }
}

export class RemoteMiningRunner implements MiningRunner {
  readonly kind: RunnerKind = "remote"

  private listeners = new Set<(t: MiningTask) => void>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private pollInFlight = false
  private hadActive = false

  async create(
    config: MiningConfig,
    opts: { device: DeviceKind; name?: string },
  ): Promise<MiningTask> {
    const task = await createTask({
      symbol: config.symbol,
      timeframe: config.timeframe,
      population: config.population,
      generations: config.generations,
      max_depth: config.max_depth,
      train_ratio: config.train_ratio,
      walk_forward_folds: config.walk_forward_folds,
      ...(config.seed_tokens?.length ? { seed_tokens: config.seed_tokens } : {}),
      // 硬性约束:服务端挖掘一律 CPU,忽略调用方传入的任何算力意图
      device: "cpu",
      ...(opts.name ? { name: opts.name } : {}),
    })
    return toUnified(task)
  }

  async list(): Promise<MiningTask[]> {
    return (await listTasks()).map(toUnified)
  }

  async get(id: string): Promise<MiningTask | null> {
    try {
      return toUnified(await getTask(id))
    } catch {
      return null
    }
  }

  async pause(id: string): Promise<void> {
    await pauseTask(id)
  }

  async resume(id: string): Promise<void> {
    await resumeTask(id)
  }

  async cancel(id: string): Promise<void> {
    await cancelTask(id)
  }

  async remove(id: string): Promise<void> {
    await deleteTask(id)
  }

  async champions(id: string): Promise<Champion[]> {
    return getChampions(id)
  }

  subscribe(cb: (t: MiningTask) => void): () => void {
    this.listeners.add(cb)
    if (this.pollTimer == null && !this.pollInFlight) this.schedulePoll(1_000)
    return () => {
      this.listeners.delete(cb)
      if (this.listeners.size === 0 && this.pollTimer != null) {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
      }
    }
  }

  /** 递归 setTimeout:上一次轮询完成后再排下一次,慢请求(默认 30s 超时)
   *  不会堆叠(P2-18) */
  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => void this.pollTick(), delayMs)
  }

  private async pollTick(): Promise<void> {
    this.pollTimer = null
    if (this.listeners.size === 0) return
    this.pollInFlight = true
    try {
      const list = await listTasks()
      this.hadActive = list.some(
        (t) => t.status === "running" || t.status === "pending",
      )
      for (const t of list) {
        const unified = toUnified(t)
        for (const cb of this.listeners) cb(unified)
      }
    } catch {
      // 轮询失败静默,保持上一拍快照,下轮再试
    } finally {
      this.pollInFlight = false
      if (this.listeners.size > 0) {
        this.schedulePoll(this.hadActive ? POLL_INTERVAL_MS : IDLE_POLL_MS)
      }
    }
  }
}
