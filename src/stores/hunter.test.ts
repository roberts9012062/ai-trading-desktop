import { beforeEach, expect, it, vi } from "vitest"
import { useHunterStore } from "./hunter"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"
import { useAiMarketStore } from "./ai-market"
vi.mock("./ai-market", () => ({ useAiMarketStore: { getState: () => ({ loadTasks: refreshWatchTasks }) } }))
const { refreshWatchTasks } = vi.hoisted(() => ({ refreshWatchTasks: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/hunter/api", () => ({ hunterApi: { list: vi.fn(), create: vi.fn(), control: vi.fn(), hosting: vi.fn() } }))
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
