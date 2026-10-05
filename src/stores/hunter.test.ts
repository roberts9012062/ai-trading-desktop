import { beforeEach, expect, it, vi } from "vitest"
import { useHunterStore } from "./hunter"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"
import { useAiMarketStore } from "./ai-market"
vi.mock("./ai-market", () => ({ useAiMarketStore: { getState: () => ({ loadTasks: refreshWatchTasks }) } }))
const { refreshWatchTasks } = vi.hoisted(() => ({ refreshWatchTasks: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/hunter/api", () => ({ hunterApi: { list: vi.fn(), create: vi.fn(), control: vi.fn() } }))
beforeEach(() => { vi.clearAllMocks(); useHunterStore.getState().reset() })

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
