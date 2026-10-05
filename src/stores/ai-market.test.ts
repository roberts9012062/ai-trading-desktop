import { beforeEach, expect, it, vi } from "vitest"
import { useAiMarketStore } from "./ai-market"
import { listAITradingTasks, listTaskTradeMarks, type AITradingTask } from "@/lib/ai-trading-api"

vi.mock("@/lib/ai-trading-api", () => ({
  listAITradingTasks: vi.fn(),
  listTaskTradeMarks: vi.fn().mockResolvedValue({ items: [] }),
  listAITradingTrades: vi.fn().mockResolvedValue({ items: [] }),
  listAITradingDecisions: vi.fn().mockResolvedValue({ items: [] }),
}))
vi.mock("@/stores/app", () => ({ useAppStore: { getState: () => ({ setActiveContract: vi.fn() }) } }))

const task = (id: string, status = "stopped", strategy_type = "multi_cycle_hunter", position_qty = 0) =>
  ({ id, status, strategy_type, position_qty, symbol: "bnbusdt" }) as AITradingTask

beforeEach(() => {
  vi.clearAllMocks()
  useAiMarketStore.setState({ tasks: [], selectedTaskId: null, marks: [], trades: [], decisions: [] })
})

it("cleans terminal hunter rows while preserving active holdings and other task history", async () => {
  const rows = [task("done"), task("failed", "failed"), task("error", "error"), task("open", "stopped", "multi_cycle_hunter", 1),
    { ...task("flag"), has_open_position: true }, task("running", "running"), task("paused", "paused"), task("ordinary", "stopped", "factor")]
  vi.mocked(listAITradingTasks).mockResolvedValue({ items: rows, total: rows.length })
  await useAiMarketStore.getState().loadTasks()
  expect(useAiMarketStore.getState().tasks.map(t => t.id)).toEqual(["open", "flag", "running", "paused", "ordinary"])
})

it("clears selection, chart marks and detail when the selected hunter finishes", async () => {
  const completed = task("selected")
  useAiMarketStore.setState({ tasks: [completed], selectedTaskId: completed.id,
    marks: [{}] as never[], trades: [{}], decisions: [{}] as never[] })
  vi.mocked(listAITradingTasks).mockResolvedValue({ items: [completed], total: 1 })
  await useAiMarketStore.getState().loadTasks(true)
  expect(useAiMarketStore.getState()).toMatchObject({ tasks: [], selectedTaskId: null, marks: [], trades: [], decisions: [] })
  expect(listTaskTradeMarks).not.toHaveBeenCalled()
})

it("selects another visible task when the chosen hunter finishes", async () => {
  useAiMarketStore.setState({ selectedTaskId: "done" })
  const running = task("next", "running", "factor")
  vi.mocked(listAITradingTasks).mockResolvedValue({ items: [task("done"), running], total: 2 })
  await useAiMarketStore.getState().loadTasks(true)
  expect(useAiMarketStore.getState().selectedTaskId).toBe("next")
})

it("does not restore an ended hunter from an older overlapping poll", async () => {
  let resolve!: (result: { items: AITradingTask[]; total: number }) => void
  vi.mocked(listAITradingTasks).mockReturnValueOnce(new Promise(r => { resolve = r }))
  const oldPoll = useAiMarketStore.getState().loadTasks(true)
  vi.mocked(listAITradingTasks).mockResolvedValueOnce({ items: [task("done")], total: 1 })
  await useAiMarketStore.getState().loadTasks(true)
  resolve({ items: [task("done", "running")], total: 1 })
  await oldPoll
  expect(useAiMarketStore.getState().tasks).toEqual([])
})
