import {beforeEach, describe, expect, it, vi} from "vitest"
vi.mock("./local-backtest", () => ({fetchBacktestBars:vi.fn()}))
import {fetchBacktestBars} from "./local-backtest"
import {backtestDataTimeframe, prepareBacktestHistory} from "./backtest-history"
import {runBacktestApi, type BacktestRunPayload} from "./backtest-api"
import {DEFAULT_KLINE_CHANNEL} from "./kline-channels"
import {getHistoryChannels} from "./history-channels"
import {researchFactorRangeFor} from "@/components/factor-lab/factor-range-limits"

const body: BacktestRunPayload = {symbol:"btcusdt",timeframe:"15m",start_date:"2026-09-28",end_date:"2026-09-28",strategy_type:"n_breakout",data_channel:"binance_usdt"}
beforeEach(() => {vi.clearAllMocks();vi.stubGlobal("fetch",vi.fn()); vi.mocked(fetchBacktestBars).mockResolvedValue([{time:"2026-09-28 00:00:00",open:100,high:101,low:99,close:100,volume:.2,settle:null,open_interest:null}])})
describe("research defaults and desktop backtest handoff", () => {
  it("replaces the research default and source list without querying server", async () => {
    expect(DEFAULT_KLINE_CHANNEL).toBe("okx")
    expect((await getHistoryChannels()).map((c) => c.id)).toEqual(["okx"])
    expect(fetch).not.toHaveBeenCalled()
    expect(researchFactorRangeFor("1d").start >= "2023-07-01").toBe(true)
  })
  it("preloads OKX with warmup and supplies decimal base volume, even if an old channel was requested", async () => {
    const r = await prepareBacktestHistory(body)
    expect(fetchBacktestBars).toHaveBeenCalledWith("btcusdt","15m","2026-09-26","2026-09-28",undefined,undefined,undefined,"okx")
    expect(r).toMatchObject({data_channel:"okx",history_source:"okx_archive_v1",history_timeframe:"15m",history_bars:[{volume:.2}]})
  })
  it("keeps smaller swing-pro period and legacy higher-factor semantics", () => {
    expect(backtestDataTimeframe({...body,strategy_type:"swing_pro",strategy_params:{htf_tf:"5m"}})).toBe("5m")
    expect(backtestDataTimeframe({...body,strategy_type:"swing_pro",strategy_params:{htf_factor:4}})).toBe("15m")
  })
  it("the actual backtest API includes local data instead of asking the server for history", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:"completed",config:{history_source:"okx_archive_v1"}})))
    await runBacktestApi({...body,strategy_type:"ai",model_row_id:"test",multi_segment:true,segment_count:2})
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))
    expect(sent).toMatchObject({history_source:"okx_archive_v1",history_timeframe:"15m",data_channel:"okx",multi_segment:true,strategy_type:"ai"})
    expect(sent.history_bars).toHaveLength(1)
  })
  it("fails before contacting the server on local download failure or unpublished dates", async () => {
    vi.mocked(fetchBacktestBars).mockRejectedValue(new Error("archive missing"))
    await expect(runBacktestApi(body)).rejects.toThrow("archive missing")
    await expect(runBacktestApi({...body,end_date:"2099-01-01"})).rejects.toThrow("已发布")
    expect(fetch).not.toHaveBeenCalled()
  })
})
