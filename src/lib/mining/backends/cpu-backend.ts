/**
 * CpuBackend —— 单 Pyodide Worker 分代步进挖掘(M3)
 *
 * M3 固定单 worker + islands=1:与服务端内核逐位一致(同一份 factor_lab
 * 代码、同 seed、同 bars → 相同结果)。多 worker 按岛并行是 M3.5。
 *
 * 会话生命周期:mine_start(bars 一次传入)→ 循环 mine_step(每代返回)
 * → done 或中止时 mine_dispose。取消/暂停 = 不再发 mine_step + dispose,
 * 控制权在 JS,内核无需埋取消标志(文档 2.7)。
 */

import type { Champion } from "@/lib/factor-lab-api"
import { ensurePyWorker } from "@/lib/py-worker"
import { getBarsSnapshot } from "../data-source"
import type { MiningConfig } from "../types"
import type {
  ComputeBackend,
  EvalRequest,
  GenerationStep,
} from "./types"

/** mine_step 的返回契约(factor_local.mine_step) */
interface MineStepResult {
  done?: boolean
  error?: string
  generation?: number
  total_generations?: number
  best_composite?: number
  champions?: Champion[]
}

let sessionSeq = 0
function newSessionId(): string {
  sessionSeq += 1
  return `mine-${Date.now().toString(36)}-${sessionSeq}`
}

/** MiningConfig → SearchConfig 字段(只透传内核认识的键) */
function buildPayload(config: MiningConfig, req: EvalRequest): Record<string, unknown> {
  return {
    symbol: config.symbol,
    crypto_profile: config.crypto_profile ?? false,
    timeframe: config.timeframe,
    population: config.population,
    generations: config.generations,
    max_depth: config.max_depth,
    train_ratio: config.train_ratio,
    ...(config.test_recent_bars != null ? { test_recent_bars: config.test_recent_bars } : {}),
    walk_forward_folds: config.walk_forward_folds,
    // M3:与服务端逐位一致要求 islands=1(多 worker 并行 M3.5 再放开)
    islands: 1,
    ...(config.top_n != null ? { top_n: config.top_n } : {}),
    ...(config.seed != null ? { seed: config.seed } : {}),
    // cost=null 由内核按品种+滑点解析(factor-local cost 陷阱:绝不透传 null)
    cost: config.cost ?? null,
    ...(config.seed_tokens?.length ? { seed_tokens: config.seed_tokens } : {}),
    // 跨品种验证:JS 预加载的同板块伙伴 bars(SearchConfig 白名单字段)
    ...(config.cross_peers?.length ? { cross_peers: config.cross_peers } : {}),
    // 本地增强(默认关;开启即不再与服务端逐位一致,这是预期)
    ...(config.selection_v2 ? { selection_v2: true } : {}),
    ...(config.evolve_v2 ? { evolve_v2: true } : {}),
    ...(config.live_entry_gate ? { live_entry_gate: config.live_entry_gate } : {}),
    // v2 研究契约(方案 §3):显式切分/因果归一化/执行模型贯通到内核
    ...(config.research_profile ? { research_profile: config.research_profile } : {}),
    ...(config.execution_model ? { execution_model: config.execution_model } : {}),
    ...(config.label_span != null ? { label_span: config.label_span } : {}),
    start_generation: req.startGeneration,
    ...(req.seedBest?.length ? { seed_best: req.seedBest } : {}),
  }
}

export class CpuBackend implements ComputeBackend {
  readonly device = "cpu" as const

  async probe(): Promise<{ available: boolean }> {
    // Pyodide worker 懒加载,能创建即视为可用;真正失败会走 rpc 错误路径
    return { available: true }
  }

  async *run(
    req: EvalRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    const snapshot = await getBarsSnapshot(req.snapshotId)
    if (!snapshot) {
      throw new Error("K 线快照不存在或已被清理,请删除任务后重新创建")
    }
    if (signal.aborted) throw new Error("已取消")

    const py = ensurePyWorker()
    const sessionId = newSessionId()
    const startResp = (await py.mineStart(
      { ...buildPayload(req.config, req), session_id: sessionId },
      snapshot.bars,
    )) as { session_id?: string; error?: string }
    if (startResp && startResp.error) {
      throw new Error(startResp.error)
    }
    const sid = startResp?.session_id ?? sessionId
    let lastChampions: Champion[] = []

    try {
      while (true) {
        // 取消/暂停点:每代之间检查,不再发 mine_step 即中止
        if (signal.aborted) return lastChampions
        const t0 = Date.now()
        const step = (await py.mineStep(sid)) as MineStepResult
        if (step && step.error) throw new Error(step.error)
        if (!step || step.done) return lastChampions
        lastChampions = step.champions ?? []
        yield {
          generation: Number(step.generation ?? 0),
          totalGenerations: Number(step.total_generations ?? req.config.generations),
          bestComposite: Number(step.best_composite ?? 0),
          champions: lastChampions,
          elapsedMs: Date.now() - t0,
        }
      }
    } finally {
      // 中止/完成/异常都释放会话(内核侧只是丢弃生成器,幂等)
      await py.mineDispose(sid).catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    // 会话在 run() 的 finally 中释放,这里无全局资源
  }
}
