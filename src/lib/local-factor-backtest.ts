import type { BacktestReport } from "./backtest-api"
import type { prepareBacktestHistory } from "./backtest-history"

/** Replay owns a separate Worker so mining / live signal Workers keep running. */
export function runPreparedFactorBacktest(
  prepared: Awaited<ReturnType<typeof prepareBacktestHistory>>,
  progress?: (message: string) => void,
): Promise<BacktestReport> {
  const { history_bars: bars, ...payload } = prepared
  const worker = new Worker(new URL("../workers/pyodide-backtest.worker.ts", import.meta.url), { type: "module" })
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, report?: BacktestReport) => {
      clearTimeout(timer)
      worker.terminate()
      if (error) reject(error)
      else resolve(report!)
    }
    const timer = setTimeout(() => finish(new Error("本机因子回测计算超时，请缩小区间或减少公式复杂度")), 20 * 60 * 1000)
    worker.onmessage = ({ data }) => {
      if (data.type === "stage") progress?.(data.message)
      else if (data.type === "error") finish(new Error(data.message))
      else if (data.type === "result" && data.reqId === 1) {
        const report = data.report as BacktestReport
        if (report?.status !== "completed" || report.config?.history_source !== payload.history_source) {
          finish(new Error("本机回测报告或数据来源校验失败"))
        } else finish(undefined, { ...report, config: { ...report.config, execution_mode: "local" } })
      }
    }
    worker.onerror = event => finish(new Error(`本机回测内核加载失败：${event.message}`))
    worker.onmessageerror = () => finish(new Error("本机回测内核返回的数据无法读取"))
    try {
      worker.postMessage({ type: "run", reqId: 1, payload: { ...payload, local_crypto_backtest: true }, bars })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
