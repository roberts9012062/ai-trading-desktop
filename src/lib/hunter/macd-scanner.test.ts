import { beforeEach, describe, expect, it, vi } from "vitest"
import fixture from "./macd-ma20-fixtures.json"
import type { Bar } from "./rules"
import { scanHunter } from "./scanner"
import { hunterApi, type Hunter, type HunterData } from "./api"
import { MACD_PERIODS, MACD_MA20_VERSION, REBOUND_VERSION, type MacdPeriod } from "./macd-ma20"
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
function shortData(count:number,period:MacdPeriod):HunterData {
  const base=data(count,period)
  return {...base,bars:{[period]:base.bars[period].map(b=>[b[0],300-b[1],300-b[3],300-b[2],300-b[4],b[5]])}}
}
describe("retired MACD hunter",()=>{
  beforeEach(()=>{vi.clearAllMocks();useHunterStore.getState().reset()})
  it("never scans or mounts even when an old server still offers it",async()=>{
    const g=group();useHunterStore.setState({groups:[g]})
    await scanHunter(g,new AbortController().signal)
    expect(hunterApi.universe).not.toHaveBeenCalled()
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
})

function reboundData(): HunterData {
  const seconds = 1800, now = fixture.now, start = 100
  const bars: Bar[] = []
  for (let i = 0; i < 110; i++) bars.push([(now-(112-i)*seconds)*1000, start, start+.05, start-.05, start, 10] as unknown as Bar)
  for (const [o, c] of [[100, 95], [95, 89.5]] as [number, number][]) {
    bars.push([(now-(112-bars.length)*seconds)*1000, o, Math.max(o, c)+.05, Math.min(o, c)-.05, c, 10] as unknown as Bar)
  }
  return { now, bars: { "30m": bars, "60m": bars }, market: [], market_week: [] }
}
describe("rebound hunter scanner", () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); useHunterStore.getState().reset(); vi.spyOn(Date, "now").mockReturnValue(fixture.now*1000) })
  it("mounts rebound long signals with entry_kind rebound", async () => {
    const g = group()
    g.config.strategy_version = REBOUND_VERSION
    g.config.direction = "both"
    g.config.rebound_threshold_pct = 10
    useHunterStore.setState({ groups: [g] })
    vi.mocked(hunterApi.universe).mockResolvedValue([{ symbol: "ethusdt", spread: 0 }] as never)
    vi.mocked(hunterApi.data).mockImplementation(async () => reboundData())
    vi.mocked(hunterApi.mount).mockResolvedValue({ id: "m", task_id: "t" })
    vi.mocked(hunterApi.list).mockResolvedValue([g])
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.mount).toHaveBeenCalledWith(g.id, expect.objectContaining({ cycle: "30m", direction: "long", entry_kind: "rebound" }), expect.any(AbortSignal))
  })
})
