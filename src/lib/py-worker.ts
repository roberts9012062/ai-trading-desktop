/**
 * Pyodide Worker 单例(回测 + 因子共用)
 * 与 local-backtest/local-factor 解耦,避免两处各起一个 worker。
 *
 * 可靠性约定(P1-9):
 * - 每次 rpc 默认带超时,超时 reject 并清理 pending,不再无限等待;
 * - worker 启动失败(reqId=0 的广播 error)会 reject 全部 pending 并废弃该
 *   worker 实例,下一次 rpc 自动拉起新 worker 重试(自愈一次性加载故障);
 * - cancelPyWorker() 通过 terminate 立即中止本地计算——Python 内核为同步
 *   阻塞执行,收不到中途消息,terminate 是唯一能立刻停下的手段,代价是下次
 *   rpc 需重新加载内核。M3 的 mine_step 分代步进落地后,长程任务按代协作
 *   取消,不必走到 terminate 这一步。
 */

type WorkerMsg =
  | { type: "ready" }
  | { type: "stage"; message: string }
  | { type: "result"; reqId: number; report: unknown }
  | { type: "error"; reqId: number; message: string }

interface PyWorkerRpc {
  run: (payload: unknown, bars: unknown, timeoutMs?: number) => Promise<unknown>
  factorRun: (payload: unknown, bars: unknown, timeoutMs?: number) => Promise<unknown>
  engineRun: (payload: unknown, arg: unknown, timeoutMs?: number) => Promise<unknown>
  /** M3 分代步进挖掘:创建会话(bars 一次性传入,会话持有) */
  mineStart: (payload: unknown, bars: unknown, timeoutMs?: number) => Promise<unknown>
  /** M3 分代步进挖掘:推进一代;返回 {done} 或该代快照 */
  mineStep: (sessionId: string, timeoutMs?: number) => Promise<unknown>
  /** M3 分代步进挖掘:销毁会话(取消 = 不再 step + dispose) */
  mineDispose: (sessionId: string, timeoutMs?: number) => Promise<unknown>
}

/** 默认超时 20 分钟:深挖(pop600×80 代 CPU)可达十几分钟级,10 分钟曾被
 *  冷加载下载挤占后误杀真实计算(Pyodide 已内置后冷载秒级,此值为纯计算兜底);传 0 表示不限 */
const DEFAULT_RPC_TIMEOUT_MS = 20 * 60 * 1000

let worker: Worker | null = null
let reqSeq = 0

/** 内核加载阶段订阅(单播,后注册覆盖;worker 冷加载期间的进度文案) */
let stageListener: ((message: string) => void) | null = null

/** 订阅内核加载阶段;返回退订函数 */
export function onKernelStage(listener: (message: string) => void): () => void {
  stageListener = listener
  return () => {
    stageListener = null
  }
}
const pending = new Map<
  number,
  {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout> | null
  }
>()

function failAll(err: Error): void {
  for (const [, p] of pending) {
    if (p.timer) clearTimeout(p.timer)
    p.reject(err)
  }
  pending.clear()
}

/** 废弃当前 worker(terminate + 置空单例),下一次 ensureWorker 重建并重试加载 */
function discardWorker(): void {
  if (!worker) return
  try {
    worker.terminate()
  } catch {
    // terminate 失败不影响重建
  }
  worker = null
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL("../workers/pyodide-backtest.worker.ts", import.meta.url), {
    type: "module",
  })
  worker.onmessage = (ev: MessageEvent<WorkerMsg>) => {
    const msg = ev.data
    if (msg.type === "ready") {
      return // 内核加载完成(worker 启动期广播,无对应请求)
    }
    if (msg.type === "stage") {
      stageListener?.(msg.message)
      return
    }
    if (msg.type === "result") {
      const p = pending.get(msg.reqId)
      if (!p) return // 已超时/已取消的请求,晚到结果直接丢弃
      if (p.timer) clearTimeout(p.timer)
      pending.delete(msg.reqId)
      p.resolve(msg.report)
      return
    }
    if (msg.type === "error") {
      // reqId=0:worker 启动期内核加载失败,整个实例已不可用——reject 全部
      // pending 并废弃,下次 rpc 重新拉起
      if (msg.reqId === 0) {
        failAll(new Error(msg.message))
        discardWorker()
        return
      }
      const p = pending.get(msg.reqId)
      if (!p) return
      if (p.timer) clearTimeout(p.timer)
      pending.delete(msg.reqId)
      p.reject(new Error(msg.message))
    }
  }
  worker.onerror = (ev) => {
    // 脚本级异常(如 worker 文件加载失败):实例不可信,同样废弃后由下次 rpc 重建
    failAll(new Error(`worker 异常: ${ev.message}`))
    discardWorker()
  }
  return worker
}

function rpc(
  type: "run" | "factor_run" | "engine_run" | "mine_start" | "mine_step" | "mine_dispose",
  payload: unknown,
  bars: unknown,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  sessionId?: string,
): Promise<unknown> {
  const w = ensureWorker()
  const reqId = ++reqSeq
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            // 超时意味着 worker 极可能已卡死(同步 Python 阻塞时收不到任何消息):
            // 该请求作废,实例一并废弃,避免后续请求排在死计算后面
            failAll(new Error(`本地计算超时(${Math.round(timeoutMs / 1000)}s),已放弃本次请求`))
            discardWorker()
          }, timeoutMs)
        : null
    pending.set(reqId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
    })
    w.postMessage(
      sessionId === undefined
        ? { type, reqId, payload, bars }
        : { type, reqId, sessionId, payload, bars },
    )
  })
}

export function ensurePyWorker(): PyWorkerRpc {
  return {
    run: (payload, bars, timeoutMs) => rpc("run", payload, bars, timeoutMs),
    factorRun: (payload, bars, timeoutMs) => rpc("factor_run", payload, bars, timeoutMs),
    engineRun: (payload, arg, timeoutMs) => rpc("engine_run", payload, arg, timeoutMs),
    mineStart: (payload, bars, timeoutMs) => rpc("mine_start", payload, bars, timeoutMs),
    mineStep: (sessionId, timeoutMs) =>
      rpc("mine_step", undefined, undefined, timeoutMs, sessionId),
    mineDispose: (sessionId, timeoutMs) =>
      rpc("mine_dispose", undefined, undefined, timeoutMs, sessionId),
  }
}

/**
 * 立即中止全部本地计算:reject 所有 pending 并 terminate worker。
 * 见文件头注释——M3 分代步进落地前的逃生舱。
 */
export function cancelPyWorker(reason = "已取消本地计算"): void {
  failAll(new Error(reason))
  discardWorker()
}
