/**
 * shard-pool.ts —— 精算分片 Pyodide worker 池(深挖强化)
 *
 * GPU 路径每代 top-K 候选的评估(内核 mine_eval_shard:execute +
 * evaluate_factor)分片到 N 个独立 Pyodide worker 并行;有状态的
 * _dedup_top(WF/测试段/跨品种)仍单点在主实例。bars 冻结(任务快照),
 * 各 worker 首次初始化时缓存 bars 与任务级参数,之后每代只传候选分片。
 *
 * 失败语义:初始化失败返回 null、评估失败抛错——均由调用方(gpu-backend)
 * 降级到主实例单进程老路径,本任务内不再重建池(罕见路径,不值得复杂化)。
 * 与 py-worker 单例完全独立:池 worker 由池独占,terminate 不影响单例。
 */

interface EvaluatedCandidate {
  composite: number
  tokens: number[]
  metrics: Record<string, unknown>
}

export interface ShardPool {
  readonly size: number
  /** 候选均分成 size 片并行评估,返回扁平结果;任一失败抛错(调用方降级) */
  evalShards(candidates: number[][]): Promise<EvaluatedCandidate[]>
  /** 严格筛预判分片并行(mine_strict_eval):返回 {tokens, pass, cross_scores};
   *  结果并入 mine_precise 的 prefetched_strict,主实例查表零重复判定 */
  evalStrict(tokensList: number[][]): Promise<StrictVerdict[]>
  dispose(): void
}

export interface StrictVerdict {
  tokens: number[]
  pass: boolean
  cross_scores: Record<string, unknown>
}

type WorkerMsg =
  | { type: "ready" }
  | { type: "result"; reqId: number; report: unknown }
  | { type: "error"; reqId: number; message: string }

/** 单个池 worker:reqId 配对 + 超时(与 py-worker 同协议,独立计数) */
interface ShardWorker {
  worker: Worker
  rpcSeq: number
}

// 含 Pyodide+numpy 冷加载与 init 的特征矩阵计算:15m 深历史(1.7 万根
// ×60+ 特征)单实例特征计算可达 1-2 分钟,深数据下 150s 会误杀真初始化
const INIT_TIMEOUT_MS = 480_000
// 15m 深历史(1.7 万根)单候选 f64 评估可达数秒;CPU 模式整种群全量评估,
// 每片数百候选 × 数秒 —— 上限必须覆盖最重合法负载,超时才是真卡死
const EVAL_TIMEOUT_MS = 900_000

function shardCount(hardwareConcurrency: number | undefined): number {
  const hc = hardwareConcurrency && hardwareConcurrency > 0 ? hardwareConcurrency : 8
  // 每个 Pyodide+numpy 实例常驻 ~150MB:上限 8(8×150MB=1.2GB,主流 16 核+
  // 32GB 机器安全);下限 1(单核机器退化为无池——由调用方按 size 判断降级)
  return Math.max(1, Math.min(8, Math.floor(hc / 2) - 1))
}

/** 池 worker 数:按逻辑核数自适应(6 核→2,8 核→3,18 核+→8) */
export function resolveShardCount(): number {
  return shardCount(
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
  )
}

function rpcOnce(
  sw: ShardWorker,
  payload: unknown,
  bars: unknown,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const reqId = ++sw.rpcSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`分片 worker ${label} 超时`))
    }, timeoutMs)
    const onMessage = (ev: MessageEvent<WorkerMsg>) => {
      const msg = ev.data
      if (msg.type !== "result" || msg.reqId !== reqId) return
      cleanup()
      resolve(msg.report)
    }
    const onError = () => {
      cleanup()
      reject(new Error(`分片 worker ${label} 异常`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      sw.worker.removeEventListener("message", onMessage)
      sw.worker.removeEventListener("error", onError)
    }
    sw.worker.addEventListener("message", onMessage)
    sw.worker.addEventListener("error", onError)
    sw.worker.postMessage({ type: "factor_run", reqId, payload, bars })
  })
}

/**
 * 创建分片池:并行初始化 n 个 worker(首次调用带 bars,内核缓存之)。
 * 任一初始化失败 → 返回 null(整体降级,不用半残池)。
 */
export async function createShardPool(opts: {
  bars: unknown
  /** 任务级参数(symbol/timeframe/train_ratio/test_recent_bars/cost/max_depth 等) */
  payload: Record<string, unknown>
  size: number
}): Promise<ShardPool | null> {
  if (opts.size < 2) return null // 单片无并行意义,直接走主实例
  const workers: ShardWorker[] = []
  try {
    const inits = Array.from({ length: opts.size }, () => {
      const sw: ShardWorker = {
        worker: new Worker(
          new URL("../../../workers/pyodide-backtest.worker.ts", import.meta.url),
          { type: "module" },
        ),
        rpcSeq: 0,
      }
      workers.push(sw)
      return rpcOnce(sw, { mode: "mine_eval_shard", ...opts.payload }, opts.bars, INIT_TIMEOUT_MS, "init")
    })
    // 弱网下多路并发冷加载可能部分失败(CDN 带宽分摊):保留成功的 worker
    // 组池(≥2 个即有并行价值),失败者 terminate,全灭才整体降级
    const settled = await Promise.allSettled(inits)
    const okWorkers: ShardWorker[] = []
    for (let i = 0; i < workers.length; i++) {
      if (settled[i].status === "fulfilled") okWorkers.push(workers[i])
      else workers[i].worker.terminate()
    }
    if (okWorkers.length < 2) {
      for (const sw of okWorkers) sw.worker.terminate()
      return null
    }
    return {
      size: okWorkers.length,
      evalShards: async (candidates) => {
        if (candidates.length === 0) return []
        // 均分:交错分片(i % n)保证各片工作量均衡(候选按粗排名有序)
        const per = Array.from({ length: okWorkers.length }, () => [] as number[][])
        candidates.forEach((c, i) => per[i % okWorkers.length].push(c))
        const results = await Promise.all(
          per.map((shard, i) =>
            shard.length === 0
              ? Promise.resolve({ evaluated: [] })
              : (rpcOnce(
                  okWorkers[i],
                  { mode: "mine_eval_shard", candidates: shard },
                  [],
                  EVAL_TIMEOUT_MS,
                  `eval#${i}`,
                ) as Promise<{ evaluated: EvaluatedCandidate[] }>),
          ),
        )
        return results.flatMap((r) => r.evaluated ?? [])
      },
      evalStrict: async (tokensList) => {
        if (tokensList.length === 0) return []
        const per = Array.from({ length: okWorkers.length }, () => [] as number[][])
        tokensList.forEach((c, i) => per[i % okWorkers.length].push(c))
        const results = await Promise.all(
          per.map((shard, i) =>
            shard.length === 0
              ? Promise.resolve({ strict: [] })
              : (rpcOnce(
                  okWorkers[i],
                  { mode: "mine_strict_eval", candidates: shard },
                  [],
                  EVAL_TIMEOUT_MS,
                  `strict#${i}`,
                ) as Promise<{ strict: StrictVerdict[] }>),
          ),
        )
        return results.flatMap((r) => r.strict ?? [])
      },
      dispose: () => {
        for (const sw of okWorkers) sw.worker.terminate()
      },
    }
  } catch {
    for (const sw of workers) sw.worker.terminate()
    return null
  }
}
