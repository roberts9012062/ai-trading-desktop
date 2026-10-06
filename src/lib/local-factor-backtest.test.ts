import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runPreparedFactorBacktest } from "./local-factor-backtest"

class ReplayWorker {
  static instances: ReplayWorker[] = []
  onmessage?: ({ data }: { data: any }) => void
  onerror?: ({ message }: { message: string }) => void
  onmessageerror?: () => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { ReplayWorker.instances.push(this) }
}
const prepared = {
  symbol: "ltcusdt", timeframe: "1d", start_date: "2025-05-31", end_date: "2025-06-29", strategy_type: "factor" as const,
  data_channel: "okx", history_source: "okx_archive_v1", history_timeframe: "1d",
  history_bars: [{ time: "2025-05-31 00:00:00", open: 90, high: 91, low: 89, close: 90, volume: .25 }],
}
beforeEach(() => { ReplayWorker.instances = []; vi.stubGlobal("Worker", ReplayWorker) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe("independent factor replay Worker", () => {
  it("keeps concurrent replays isolated and sends bars only once", async () => {
    const progress = vi.fn(), first = runPreparedFactorBacktest(prepared, progress), second = runPreparedFactorBacktest(prepared)
    const [a,b] = ReplayWorker.instances
    expect(a).not.toBe(b)
    const request = a!.postMessage.mock.calls[0]![0]
    expect(request.payload.history_bars).toBeUndefined()
    expect(request.bars).toBe(prepared.history_bars)
    a!.onmessage?.({data:{type:"stage",message:"计算中"}})
    expect(progress).toHaveBeenCalledWith("计算中")
    a!.onmessage?.({data:{type:"result",reqId:1,report:{status:"completed",config:{history_source:"okx_archive_v1"}}}})
    await expect(first).resolves.toMatchObject({config:{execution_mode:"local"}})
    expect(a!.terminate).toHaveBeenCalledOnce()
    expect(b!.terminate).not.toHaveBeenCalled()
    b!.onmessage?.({data:{type:"error",reqId:0,message:"加载失败"}})
    await expect(second).rejects.toThrow("加载失败")
    expect(b!.terminate).toHaveBeenCalledOnce()
  })
  it("rejects mismatched provenance instead of displaying a misleading report", async () => {
    const run=runPreparedFactorBacktest(prepared), worker=ReplayWorker.instances[0]!
    worker.onmessage?.({data:{type:"result",reqId:1,report:{status:"completed",config:{history_source:"binance_um_archive_v1"}}}})
    await expect(run).rejects.toThrow("数据来源校验失败")
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it("stops only its own Worker on timeout", async () => {
    vi.useFakeTimers()
    const run=runPreparedFactorBacktest(prepared), worker=ReplayWorker.instances[0]!
    const rejected=expect(run).rejects.toThrow("本机因子回测计算超时")
    await vi.advanceTimersByTimeAsync(20*60*1000)
    await rejected
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
