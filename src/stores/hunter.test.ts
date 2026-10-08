import { beforeEach, expect, it, vi } from "vitest"
import { useHunterStore } from "./hunter"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"
import { useAiMarketStore } from "./ai-market"
vi.mock("./ai-market", () => ({ useAiMarketStore: { getState: () => ({ loadTasks: refreshWatchTasks }) } }))
const { refreshWatchTasks } = vi.hoisted(() => ({ refreshWatchTasks: vi.fn().mockResolvedValue(undefined) }))
const aiTasks = vi.hoisted(() => ({ tasks: [] as { id: string }[], loadTasks: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/stores/ai-trading", () => ({ useAITradingStore: { getState: () => aiTasks } }))
vi.mock("@/lib/hunter/api", () => ({ hunterApi: { list: vi.fn(), create: vi.fn(), control: vi.fn(), hosting: vi.fn(), setBottomLine: vi.fn() } }))
beforeEach(() => { vi.clearAllMocks(); aiTasks.tasks = []; useHunterStore.getState().reset() })

it("never restores an old session's groups after logout or mode change", async () => {
  let resolve!: (groups: Hunter[]) => void
  vi.mocked(hunterApi.list).mockReturnValue(new Promise(r => { resolve = r }))
  const pending = useHunterStore.getState().refresh()
  useHunterStore.getState().reset()
  resolve([{ id: "previous-user" }] as Hunter[])
  await pending
  expect(useHunterStore.getState().groups).toEqual([])
})

it("discards a late create response from a previous session", async () => {
  let resolve!: (group: Hunter) => void
  vi.mocked(hunterApi.create).mockReturnValue(new Promise(r => { resolve = r }))
  const pending = useHunterStore.getState().create({} as HunterConfig)
  useHunterStore.getState().reset()
  resolve({ id: "previous-user" } as Hunter)
  await expect(pending).rejects.toThrow("会话")
  expect(useHunterStore.getState().groups).toEqual([])
})

it("refreshes the watching task list after stopping a hunter", async () => {
  vi.mocked(hunterApi.control).mockResolvedValue({ id: "hunter", status: "stopped" } as Hunter)
  await useHunterStore.getState().control("hunter", "stop")
  await vi.waitFor(() => expect(useAiMarketStore.getState().loadTasks).toHaveBeenCalledWith(true))
})

it("updates scan ownership and clears desktop candidates when hosting changes", async () => {
  const group = { id: "hunter", status: "running", config: { scan_location: "server" } } as Hunter
  useHunterStore.setState({ groups: [{ ...group, config: { scan_location: "desktop" } } as Hunter], watches: { hunter: [] } })
  vi.mocked(hunterApi.hosting).mockResolvedValue(group)
  await useHunterStore.getState().setHosting("hunter", "server")
  expect(useHunterStore.getState().groups[0].config.scan_location).toBe("server")
  expect(useHunterStore.getState().watches.hunter).toEqual([])
})

it("discards a late hosting response after logout", async () => {
  let resolve!: (group: Hunter) => void
  vi.mocked(hunterApi.hosting).mockReturnValue(new Promise(r => { resolve = r }))
  const pending = useHunterStore.getState().setHosting("hunter", "server")
  useHunterStore.getState().reset()
  resolve({ id: "previous-user" } as Hunter)
  await expect(pending).rejects.toThrow("会话")
  expect(useHunterStore.getState().groups).toEqual([])
})

it("refreshes newly hosted child IDs before the task poll and skips known children", async () => {
  vi.mocked(hunterApi.list).mockResolvedValue([{ id: "hunter", status: "running", opportunities: [{ task_id: "new", finished_at: null }] }] as Hunter[])
  await useHunterStore.getState().refresh()
  await vi.waitFor(() => expect(aiTasks.loadTasks).toHaveBeenCalledWith({ silent: true }))
  aiTasks.loadTasks.mockClear(); aiTasks.tasks = [{ id: "new" }]
  await useHunterStore.getState().refresh()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(aiTasks.loadTasks).not.toHaveBeenCalled()
})

it("saves only bottom thresholds, preserves other config and reloads child tasks", async () => {
  useHunterStore.setState({ groups: [{ id: "hunter", config: { leverage: 5, profit_lock: { enabled: true } } } as Hunter] })
  vi.mocked(hunterApi.setBottomLine).mockResolvedValue({ id: "hunter", max_profit_pct: null, max_loss_pct: 25, bottom_line_revision: "revision", affected_tasks: 2 })
  await useHunterStore.getState().setBottomLine("hunter", { max_profit_pct: null, max_loss_pct: 25 })
  expect(hunterApi.setBottomLine).toHaveBeenCalledWith("hunter", { max_profit_pct: null, max_loss_pct: 25 })
  expect(useHunterStore.getState().groups[0].config).toEqual({ leverage: 5, profit_lock: { enabled: true }, max_profit_pct: null, max_loss_pct: 25, bottom_line_revision: "revision" })
  expect(aiTasks.loadTasks).toHaveBeenCalledWith({ silent: true })
})

it("discards late bottom edits and task refresh after a session change", async () => {
  let resolve!: (result: Awaited<ReturnType<typeof hunterApi.setBottomLine>>) => void
  vi.mocked(hunterApi.setBottomLine).mockReturnValue(new Promise(r => { resolve = r }))
  const pending = useHunterStore.getState().setBottomLine("old", { max_profit_pct: 20, max_loss_pct: 10 })
  useHunterStore.getState().reset()
  resolve({ id: "old", max_profit_pct: 20, max_loss_pct: 10, bottom_line_revision: "old", affected_tasks: 1 })
  await expect(pending).rejects.toThrow("会话")
  expect(useHunterStore.getState().groups).toEqual([])
  expect(aiTasks.loadTasks).not.toHaveBeenCalled()
})
