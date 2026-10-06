import { beforeEach, describe, expect, it, vi } from "vitest"
import fixture from "./macd-ma20-fixtures.json"
import { scanHunter } from "./scanner"
import { hunterApi, type Hunter, type HunterData } from "./api"
import { MACD_PERIODS, MACD_MA20_VERSION, type MacdPeriod } from "./macd-ma20"
import { useHunterStore } from "@/stores/hunter"

vi.mock("@/stores/ai-trading",()=>({useAITradingStore:{getState:()=>({loadTasks:vi.fn()})}}))
vi.mock("@/stores/auth",()=>({useAuthStore:{getState:()=>({user:null})}}))
vi.mock("./api",()=>({hunterApi:{universe:vi.fn(),data:vi.fn(),mount:vi.fn(),list:vi.fn()}}))
const group = (): Hunter=>({id:"new-hunter",status:"running",blocks:[],config:{venue:"okx",strategy_version:MACD_MA20_VERSION,
  cycles:["30m","60m"],direction:"long",max_positions:4},opportunities:[]} as unknown as Hunter)
function data(count:number,period:MacdPeriod):HunterData {
  const prices=fixture.prices[String(count) as keyof typeof fixture.prices], seconds=MACD_PERIODS[period]
  return {now:fixture.now,bars:{[period]:prices.map((p,i)=>[(fixture.now-(prices.length-i)*seconds)*1000,p,p+.1,p-.1,p,100])},market:[],market_week:[]}
}
describe("independent MACD hunter scanner",()=>{
  beforeEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();useHunterStore.getState().reset();vi.spyOn(Date,"now").mockReturnValue(fixture.now*1000)})
  it("scans 60m even when 30m has already run for five above-MA candles",async()=>{
    const g=group();useHunterStore.setState({groups:[g]})
    vi.mocked(hunterApi.universe).mockResolvedValue([{symbol:"ethusdt",spread:0}] as never)
    vi.mocked(hunterApi.data).mockImplementation(async (_id,_symbol,period)=>data(period==="30m"?5:3,period as MacdPeriod))
    vi.mocked(hunterApi.mount).mockResolvedValue({id:"mounted",task_id:"task"})
    vi.mocked(hunterApi.list).mockResolvedValue([g])
    await scanHunter(g,new AbortController().signal)
    expect(hunterApi.mount).toHaveBeenCalledTimes(1)
    expect(hunterApi.mount).toHaveBeenCalledWith(g.id,expect.objectContaining({cycle:"60m",direction:"long",entry_kind:"macd_ma20"}),expect.any(AbortSignal))
  })
  it("does not mount outside the 3–4 candle window or during cooldown",async()=>{
    const g=group();useHunterStore.setState({groups:[g]})
    vi.mocked(hunterApi.universe).mockResolvedValue([{symbol:"ethusdt",spread:0}] as never)
    vi.mocked(hunterApi.data).mockImplementation(async (_id,_symbol,period)=>data(5,period as MacdPeriod))
    await scanHunter(g,new AbortController().signal)
    expect(hunterApi.mount).not.toHaveBeenCalled()
    await scanHunter({...g,blocks:["亏损冷静期"]},new AbortController().signal)
    expect(hunterApi.universe).toHaveBeenCalledTimes(1)
  })
  it("does not run desktop scans for server-hosted hunters",async()=>{
    const g=group();g.config.scan_location="server";useHunterStore.setState({groups:[g]})
    await scanHunter(g,new AbortController().signal)
    expect(hunterApi.universe).not.toHaveBeenCalled()
    expect(hunterApi.data).not.toHaveBeenCalled()
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
})
