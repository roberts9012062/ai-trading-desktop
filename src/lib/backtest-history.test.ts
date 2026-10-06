import {beforeEach, describe, expect, it, vi} from "vitest"
vi.mock("./local-backtest", () => ({fetchBacktestBars:vi.fn()}))
vi.mock("./local-factor-backtest", () => ({runPreparedFactorBacktest:vi.fn()}))
import {runPreparedFactorBacktest} from "./local-factor-backtest"
import {fetchBacktestBars} from "./local-backtest"
import {backtestDataTimeframe, backtestWarmupBars, prepareBacktestHistory} from "./backtest-history"
import {runBacktestApi, type BacktestRunPayload} from "./backtest-api"
import {DEFAULT_KLINE_CHANNEL} from "./kline-channels"
import {getHistoryChannels} from "./history-channels"
import {researchFactorRangeFor} from "@/components/factor-lab/factor-range-limits"

const body: BacktestRunPayload = {symbol:"btcusdt",timeframe:"15m",start_date:"2026-09-28",end_date:"2026-09-28",strategy_type:"n_breakout",data_channel:"okx"}
beforeEach(() => {vi.clearAllMocks();vi.stubGlobal("fetch",vi.fn()); vi.mocked(fetchBacktestBars).mockResolvedValue([{time:"2026-09-28 00:00:00",open:100,high:101,low:99,close:100,volume:.2,settle:null,open_interest:null}])})
describe("research defaults and desktop backtest handoff", () => {
  it("executes the LTC factor formula locally without uploading bars to a server", async () => {
    const formula = [47,83,81,31,2,65,22,107,68,112,84,5,4,66,78,96,101,64,64]
    const report = {status:"completed",config:{history_source:"okx_archive_v1",execution_mode:"local"}} as any
    vi.mocked(runPreparedFactorBacktest).mockResolvedValue(report)
    const result = await runBacktestApi({...body,symbol:"ltcusdt",strategy_type:"factor",strategy_params:{factor_tokens:formula},leverage:5,margin_per_trade:100})
    expect(result).toBe(report)
    expect(runPreparedFactorBacktest).toHaveBeenCalledWith(expect.objectContaining({symbol:"ltcusdt",strategy_params:{factor_tokens:formula},history_source:"okx_archive_v1",leverage:5,margin_per_trade:100}),undefined)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("prefetches enough history for long parameters and minute factor normalization", async () => {
    expect(backtestWarmupBars({...body,strategy_type:"ma_cross",strategy_params:{slow_period:300}})).toBeGreaterThanOrEqual(301)
    expect(backtestWarmupBars({...body,strategy_type:"macd_cross",strategy_params:{slow_period:200,signal_period:100}})).toBeGreaterThanOrEqual(302)
    expect(backtestWarmupBars({...body,strategy_type:"macd_cross",strategy_params:{fast_period:100,slow_period:3}})).toBe(552)
    expect(backtestWarmupBars({...body,timeframe:"1m",strategy_type:"factor",strategy_params:{factor_tokens:[0,135]}})).toBeGreaterThan(2880)
    await prepareBacktestHistory({...body,strategy_type:"swing_pro",strategy_params:{htf_tf:"5m"}})
    expect(fetchBacktestBars).toHaveBeenCalledWith("btcusdt","5m","2026-09-25","2026-09-28",undefined,undefined,undefined,"okx")
  })
  it("replaces the research default and source list without querying server", async () => {
    expect(DEFAULT_KLINE_CHANNEL).toBe("okx")
    expect((await getHistoryChannels()).map((c) => c.id)).toEqual(["okx", "binance_usdt"])
    expect(fetch).not.toHaveBeenCalled()
    expect(researchFactorRangeFor("1d").start >= "2023-07-01").toBe(true)
  })
  it("keeps explicit Binance perpetual provenance through the server calculation handoff", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:"completed",config:{history_source:"binance_um_archive_v1"}})))
    await runBacktestApi({...body,data_channel:"binance_usdt",start_date:"2022-01-02",end_date:"2022-01-03"})
    expect(fetchBacktestBars).toHaveBeenCalledWith("btcusdt","15m","2021-12-30","2022-01-03",undefined,undefined,undefined,"binance_usdt")
    const sent=JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))
    expect(sent).toMatchObject({data_channel:"binance_usdt",history_source:"binance_um_archive_v1",history_timeframe:"15m"})
  })
  it("preloads OKX with warmup and supplies decimal base volume", async () => {
    const r = await prepareBacktestHistory(body)
    expect(fetchBacktestBars).toHaveBeenCalledWith("btcusdt","15m","2026-09-25","2026-09-28",undefined,undefined,undefined,"okx")
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
