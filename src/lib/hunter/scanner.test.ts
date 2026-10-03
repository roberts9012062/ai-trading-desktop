import { beforeEach, describe, expect, it, vi } from "vitest"
import { hunterApi, type Hunter, type HunterData } from "./api"
import { scanHunter } from "./scanner"
import { useHunterStore } from "@/stores/hunter"

vi.mock("@/stores/ai-trading", () => ({ useAITradingStore: { getState: () => ({ loadTasks: vi.fn() }) } }))
vi.mock("@/stores/auth", () => ({ useAuthStore: { getState: () => ({ user: null }) } }))
vi.mock("./api", () => ({ hunterApi: { universe: vi.fn(), data: vi.fn(), mount: vi.fn() } }))
const group = () => ({
  id: "h", status: "running", blocks: [],
  config: { venue: "okx", cycles: ["short"], direction: "long", max_positions: 4 },
  opportunities: [{ symbol: "btcusdt", finished_at: null }],
}) as unknown as Hunter
const data = { now: 1900000000, bars: { "1d": [[1800000000000, 100, 102, 98, 100, 10]], "1h": [] }, market: [], market_week: [] } as HunterData

describe("hunter discovery ownership", () => {
  beforeEach(() => { vi.clearAllMocks(); useHunterStore.getState().reset() })
  it("does not search a legacy hunter with a non-OKX venue", async () => {
    const g = { ...group(), config: { ...group().config, venue: "binance" } } as unknown as Hunter
    useHunterStore.setState({ groups: [g] })
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.universe).not.toHaveBeenCalled()
    expect(hunterApi.data).not.toHaveBeenCalled()
    expect(hunterApi.mount).not.toHaveBeenCalled()
    expect(useHunterStore.getState().progress[g.id]).toContain("OKX")
  })
  it("fetches held coins for ranking without mounting a second task", async () => {
    const g = group()
    useHunterStore.setState({ groups: [g] })
    vi.mocked(hunterApi.universe).mockResolvedValue([{ symbol: "btcusdt", spread: 0 }] as never)
    vi.mocked(hunterApi.data).mockResolvedValue(data)
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.data).toHaveBeenCalledWith("h", "btcusdt", "short", expect.any(AbortSignal))
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
  it("stops discovery after the group is paused while reading the universe", async () => {
    const g = group()
    useHunterStore.setState({ groups: [g] })
    vi.mocked(hunterApi.universe).mockImplementation(async () => {
      useHunterStore.setState({ groups: [{ ...g, status: "paused" }] })
      return [{ symbol: "ethusdt", spread: 0 }] as never
    })
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.data).not.toHaveBeenCalled()
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
  it("explains an empty scan without treating missing history as a trading sample", async () => {
    const g = group()
    useHunterStore.setState({ groups: [g] })
    vi.mocked(hunterApi.universe).mockResolvedValue([{ symbol: "ethusdt", spread: 0 }] as never)
    vi.mocked(hunterApi.data).mockResolvedValue(data)
    await scanHunter(g, new AbortController().signal)
    const report = useHunterStore.getState().progress[g.id]
    expect(report).toContain("历史不足 1")
    expect(report).toContain("有效信号 0")
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
  it("keeps the data failure reason visible rather than reporting no signal", async () => {
    const g = group()
    useHunterStore.setState({ groups: [g] })
    vi.mocked(hunterApi.universe).mockResolvedValue([{ symbol: "ethusdt", spread: 0 }] as never)
    vi.mocked(hunterApi.data).mockRejectedValue(new Error("OKX 行情限流"))
    await scanHunter(g, new AbortController().signal)
    const report = useHunterStore.getState().progress[g.id]
    expect(report).toContain("行情失败 1")
    expect(report).toContain("OKX 行情限流")
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
})
