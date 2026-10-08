import { beforeEach, describe, expect, it, vi } from "vitest"
import fixture from "./pivot-fixtures.json"
import { scanHunter } from "./scanner"
import { hunterApi, type Hunter, type HunterData } from "./api"
import { useHunterStore } from "@/stores/hunter"
import type { Bar } from "./rules"

vi.mock("@/stores/ai-trading", () => ({ useAITradingStore: { getState: () => ({ loadTasks: vi.fn() }) } }))
vi.mock("@/stores/auth", () => ({ useAuthStore: { getState: () => ({ user: null }) } }))
vi.mock("./api", () => ({ hunterApi: { universe: vi.fn(), data: vi.fn(), mount: vi.fn(), list: vi.fn() } }))
function group(): Hunter {
  return { id: "pivot", status: "running", blocks: [], runtime: {}, config: {
    strategy_version: "hunter-pivot", cycles: ["60m"], direction: "both", max_positions: 10,
    pool_size: 50, pivot_params: fixture[0].params,
  }, opportunities: [] } as unknown as Hunter
}
function data(index = 1): HunterData {
  const direction = fixture[index].direction
  const rows = fixture[index].rows.map((b, i) => i >= fixture[index].rows.length-2 ? [b[0], b[4]+(direction === "short" ? 2 : -2), ...b.slice(2)] : b)
  return { now: fixture[index].now, bars: { "60m": rows as Bar[] }, market: [], market_week: [] }
}
describe("pivot batch scanner", () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); useHunterStore.getState().reset(); vi.spyOn(Date, "now").mockReturnValue(fixture[0].now*1000) })
  function setup(g: Hunter, count = 15) {
    useHunterStore.setState({ groups: [g] })
    vi.mocked(hunterApi.universe).mockResolvedValue(Array.from({ length: count }, (_, i) => ({ symbol: `coin${i}usdt` })) as never)
    vi.mocked(hunterApi.data).mockResolvedValue(data())
    vi.mocked(hunterApi.mount).mockResolvedValue({ id: "mounted" })
    vi.mocked(hunterApi.list).mockResolvedValue([g])
  }
  it("mounts ten independent orders instead of returning after the first", async () => {
    const g = group(); setup(g)
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.mount).toHaveBeenCalledTimes(10)
    expect(hunterApi.mount).toHaveBeenCalledWith(g.id, expect.objectContaining({ cycle: "60m", direction: "long", entry_kind: "swing_pivot" }), expect.any(AbortSignal))
  })
  it("counts reservations and skips both active and cooling coins before market reads", async () => {
    const g = group(); g.opportunities = [{ symbol: "coin0usdt", finished_at: null }] as never
    g.runtime.symbol_cooldowns = { coin1usdt: { active: true, loss_count: 2, reset_at: "2026-10-09T06:00:00+08:00" } }
    setup(g)
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.mount).toHaveBeenCalledTimes(9)
    expect(hunterApi.data).not.toHaveBeenCalledWith(g.id, "coin0usdt", "60m", expect.anything())
    expect(hunterApi.data).not.toHaveBeenCalledWith(g.id, "coin1usdt", "60m", expect.anything())
  })
  it("shares one snapshot for long/short and mounts short pivots", async () => {
    const g = group(); setup(g, 1); vi.mocked(hunterApi.data).mockResolvedValue(data(6))
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.data).toHaveBeenCalledTimes(1)
    expect(hunterApi.mount).toHaveBeenCalledWith(g.id, expect.objectContaining({ direction: "short" }), expect.any(AbortSignal))
  })
  it("does not mount a five-bar-old pivot", async () => {
    const g = group(); setup(g, 1); vi.mocked(hunterApi.data).mockResolvedValue(data(3))
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.mount).not.toHaveBeenCalled()
  })
  it("stops a batch after pause or configuration changes", async () => {
    const g = group(); setup(g)
    vi.mocked(hunterApi.mount).mockImplementation(async () => { useHunterStore.setState({ groups: [{ ...g, status: "paused" }] }); return { id: "m" } })
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.mount).toHaveBeenCalledTimes(1)
  })
  it("uses at most three concurrent market reads and clamps the pool to 200", async () => {
    const g = group(); g.config.pool_size = 200; setup(g, 210)
    let active = 0, peak = 0
    vi.mocked(hunterApi.data).mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return data(3) })
    await scanHunter(g, new AbortController().signal)
    expect(hunterApi.data).toHaveBeenCalledTimes(200); expect(peak).toBe(3)
  })
})
