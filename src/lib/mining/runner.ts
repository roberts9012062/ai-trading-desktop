/**
 * MiningRunner 接口 + 工厂(M2) —— 本地/服务端挖掘的统一编排面
 *
 * UI(super-factor-page / use-mining-tasks)只面向本接口编程;列表把
 * 多个 runner 的结果合并展示(按 updated_at 倒序)。
 * - remote:包装现有 super-factor-api(服务端长程任务);
 * - local:本地 CPU/GPU 挖掘,M3 接入。
 */

import type { Champion } from "@/lib/factor-lab-api"
import type { DeviceKind, MiningConfig, MiningTask, RunnerKind } from "./types"
import { RemoteMiningRunner } from "./remote-runner"
import { LocalMiningRunner } from "./local-runner"

export interface MiningRunner {
  kind: RunnerKind
  create(
    config: MiningConfig,
    opts: { device: DeviceKind; name?: string },
  ): Promise<MiningTask>
  list(): Promise<MiningTask[]>
  get(id: string): Promise<MiningTask | null>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  cancel(id: string): Promise<void>
  remove(id: string): Promise<void>
  champions(id: string): Promise<Champion[]>
  /** 任务更新事件流:本地实现按代推事件;远端实现内部轮询后转成同样的事件 */
  subscribe(cb: (t: MiningTask) => void): () => void
}

// 单例:remote 内部持有订阅轮询器、local 持有任务状态机与启动恢复,
// 多处以同一实例操作才不会各起一套状态
let remoteInstance: RemoteMiningRunner | null = null
let localInstance: LocalMiningRunner | null = null

export function createRunner(kind: RunnerKind): MiningRunner {
  if (kind === "remote") {
    if (!remoteInstance) remoteInstance = new RemoteMiningRunner()
    return remoteInstance
  }
  if (kind === "local") {
    if (!localInstance) localInstance = new LocalMiningRunner()
    return localInstance
  }
  throw new Error(`未知 runner: ${kind}`)
}
