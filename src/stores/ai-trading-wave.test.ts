import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { useAITradingStore } from "./ai-trading"
import { useAuthStore } from "./auth"
import { listAITradingTasks } from "@/lib/ai-trading-api"
import type { AITradingTask } from "@/lib/ai-trading-api"
import type { User } from "@/types"
import { clearWaveCache, readWaveCache, saveWaveCache } from "@/components/ai-trading/equity/equity-wave-cache"

vi.mock("@/lib/ai-trading-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/ai-trading-api")>(), listAITradingTasks: vi.fn() }))
const start = Date.parse("2026-10-04T04:00:00Z")
const user = { id: "owner", username: "fixture", trading_mode: "live" } as User
const open = { id: "one", user_id: "owner", symbol: "btcusdt", position_qty: 1, position_direction: "long", has_open_position: true, position_opened_at: new Date(start).toISOString(), position_unrealized: 1 } as AITradingTask
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(start + 1000)
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  clearWaveCache()
  useAuthStore.setState({ user })
  useAITradingStore.setState({ tasks: [], equityTraces: {}, equitySeries: {}, waveOwner: null })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it("collects actual successful task refreshes without chart rendering or a historical equity request", async () => {
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [open] })
  await useAITradingStore.getState().loadTasks()
  vi.setSystemTime(start + 2000)
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [{ ...open, position_unrealized: -2 }] })
  await useAITradingStore.getState().loadTasks({ silent: true })
  expect(useAITradingStore.getState().equityTraces.one.samples.map(p => p.value)).toEqual([1, -2])
})
it("retains traces on failed polling; a confirmed close immediately clears persisted traces", async () => {
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [open] })
  await useAITradingStore.getState().loadTasks()
  const before = useAITradingStore.getState().equityTraces
  vi.mocked(listAITradingTasks).mockRejectedValue(new Error("offline"))
  await useAITradingStore.getState().loadTasks({ silent: true })
  expect(useAITradingStore.getState().equityTraces).toBe(before)
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [{ ...open, position_qty: 0, position_direction: null, has_open_position: false }] })
  await useAITradingStore.getState().loadTasks({ silent: true })
  expect(useAITradingStore.getState().equityTraces).toEqual({})
  expect(readWaveCache(JSON.stringify([user.id, user.trading_mode]))).toEqual({})
})
it("restores cache only after matching the current position, and never attaches the closed trade to a reopening", async () => {
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [open] })
  await useAITradingStore.getState().loadTasks()
  useAITradingStore.setState({ equityTraces: {}, waveOwner: null })
  vi.setSystemTime(start + 6000)
  await useAITradingStore.getState().loadTasks()
  expect(useAITradingStore.getState().equityTraces.one.samples).toHaveLength(2)
  useAITradingStore.setState({ equityTraces: {}, waveOwner: null })
  vi.setSystemTime(start + 8000)
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [{ ...open, position_opened_at: new Date(start + 7000).toISOString() }] })
  await useAITradingStore.getState().loadTasks()
  expect(useAITradingStore.getState().equityTraces.one.samples).toEqual([{ time: start + 8000, value: 1 }])
})
it("ignores an older response delivered after a confirmed close", async () => {
  let resolve!: (value: { total: number; items: AITradingTask[] }) => void
  vi.mocked(listAITradingTasks).mockReturnValueOnce(new Promise(r => { resolve = r }))
  const pending = useAITradingStore.getState().loadTasks()
  vi.mocked(listAITradingTasks).mockResolvedValueOnce({ total: 0, items: [] })
  await useAITradingStore.getState().loadTasks()
  resolve({ total: 1, items: [open] }); await pending
  expect(useAITradingStore.getState().tasks).toEqual([])
  expect(useAITradingStore.getState().equityTraces).toEqual({})
})
it("clears waves on user/mode changes and discards outstanding responses even after switching back", async () => {
  let resolve!: (value: { total: number; items: AITradingTask[] }) => void
  vi.mocked(listAITradingTasks).mockResolvedValueOnce({ total: 1, items: [open] })
  await useAITradingStore.getState().loadTasks()
  vi.mocked(listAITradingTasks).mockReturnValueOnce(new Promise(r => { resolve = r }))
  const pending = useAITradingStore.getState().loadTasks()
  useAuthStore.setState({ user: { ...user, trading_mode: "virtual" } })
  expect(useAITradingStore.getState().equityTraces).toEqual({})
  expect(readWaveCache(JSON.stringify([user.id, user.trading_mode]))).toEqual({})
  useAuthStore.setState({ user })
  resolve({ total: 1, items: [open] }); await pending
  expect(useAITradingStore.getState().tasks).toEqual([])
})
it("never loads cached waves for another user or restores a malformed/missing position identity", async () => {
  vi.mocked(listAITradingTasks).mockResolvedValue({ total: 1, items: [open] })
  await useAITradingStore.getState().loadTasks()
  const owner = JSON.stringify([user.id, user.trading_mode])
  expect(readWaveCache(JSON.stringify(["different-owner", user.trading_mode]))).toEqual({})
  const cached = useAITradingStore.getState().equityTraces
  saveWaveCache(owner, { one: { ...cached.one, openedAt: null } }, start + 10000)
  expect(readWaveCache(owner)).toEqual({})
  saveWaveCache(owner, { one: { ...cached.one, samples: [{ time: start + 1000, value: 1 }, { time: start, value: 2 }] } }, start + 20000)
  expect(readWaveCache(owner)).toEqual({})
})
