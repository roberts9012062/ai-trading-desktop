/**
 * 挖掘编排层统一类型(M2) —— 本地/服务端两条路径共用
 *
 * MiningTask 与服务端 MiningTask(super-factor-api)字段对齐,并加
 * origin/device/本地专属字段;remote-runner 负责把服务端 DTO 映射进来。
 */

import type { Champion, PortfolioResult } from "@/lib/factor-lab-api"
import type { GpuStepStats } from "./backends/types"

export type RunnerKind = "local" | "remote"
export type DeviceKind = "auto" | "cpu" | "gpu"

/** 挖掘配置(两种执行位置共用)。islands/top_n/seed/cost 仅本地路径消费,
 *  缺省由 local-runner 填默认值;服务端 CreateTaskPayload 不含这些字段。 */
export interface MiningConfig {
  crypto_profile?: boolean
  kernel_version?: string
  symbol: string
  timeframe: string
  /** 数据渠道(okx/binance_spot/gate_spot;缺省 binance_spot)——bars 快照与取数分流 */
  data_channel?: string
  population: number
  generations: number
  max_depth: number
  train_ratio: number
  test_recent_bars?: number
  walk_forward_folds: number
  /** 本地 CPU 多 worker 按岛分片(M3.5);默认 = worker 数 */
  islands?: number
  top_n?: number
  seed?: number
  cost?: number | null
  seed_tokens?: number[][]
  /** 跨品种验证伙伴 bars:[[品种代码, bars], ...](JS 预加载注入;
   *  严格筛要求 ≥⌈K/2⌉ 个伙伴 sortino>0,与内核 SearchConfig.cross_peers 同构) */
  cross_peers?: Array<[string, Array<Record<string, unknown>>]>
  /** 本地增强遴选(内核 SearchConfig.selection_v2):行为去重先行 + 验证/封存
   *  三段切分 + DSR。仅本地路径;关闭时与服务端内核逐位一致 */
  selection_v2?: boolean
  /** 本地进化增强(SearchConfig.evolve_v2):点/收缩变异、克隆降权、零平台细分、停滞重启 */
  evolve_v2?: boolean
  /** 实盘离散口径门(SearchConfig.live_entry_gate):>0 时严格筛按该开仓阈值验证 */
  live_entry_gate?: number
  /** 研究契约版本(crypto_local_v2 = 60/20/20 显式切分+严格因果归一化+
   *  样本充分性门+封存揭示;缺省/crypto_ohlcv_v1 = 旧语义逐位不变) */
  research_profile?: string
  /** 执行模型(signal_research|spot_long_flat|perp_next_open):v2 时严格筛
   *  按该模型的净收益(含 funding 事件现金流)验证 */
  execution_model?: string
  /** 收益标签跨度 bar 数(v2;末尾不足的不补 0 参加统计) */
  label_span?: number
  start_date?: string
  end_date?: string
}

export interface MiningTask {
  id: string
  /** 任务归属的执行位置(UI 据此打「本机/服务器」标签并路由操作) */
  origin: RunnerKind
  /** "server" = 服务端任务(服务端一律 CPU);本地任务为用户选择的算力 */
  device: DeviceKind | "server"
  /** 本地任务实际落到的算力(auto 解析后);服务端任务恒 "cpu" */
  effectiveDevice?: "cpu" | "gpu"
  name: string
  symbol: string
  timeframe: string
  population: number
  generations: number
  max_depth: number
  train_ratio: number
  walk_forward_folds: number
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled"
  pause_reason: string | null
  current_generation: number
  best_composite: number
  progress_pct: number
  champions_count: number
  bars_count: number
  data_range_from: string | null
  data_range_to: string | null
  error_msg: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string | null
  created_at?: string | null
  // 本地专属
  snapshotId?: string
  config?: MiningConfig
  /** 累计计算用时 ms(不含排队/暂停;本机任务) */
  elapsed_ms?: number
  /** 冠军组合评估(本地任务完成时产出;深挖强化 M4) */
  portfolio?: PortfolioResult | null
  /** 最近一代 GPU 活动统计(粗排吞吐/缓存/显存/精算并行;GPU 任务) */
  gpu_stats?: GpuStepStats | null
}

/** 供 runner.champions 的返回类型显式化(与 factor-lab 同构) */
export type MiningChampion = Champion
