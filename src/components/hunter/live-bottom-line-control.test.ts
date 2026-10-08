import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import type { Hunter } from "@/lib/hunter/api"
vi.mock("@/stores/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user" } }) }))
vi.mock("@/stores/hunter", () => ({ useHunterStore: (select: (s: unknown) => unknown) => select({ setBottomLine: vi.fn() }) }))
vi.mock("@/stores/ai-trading", () => ({ useAITradingStore: (select: (s: unknown) => unknown) => select({ tasks: [{ id: "task", symbol: "xrpusdt", position_qty: 700, position_margin: 100, position_unrealized: -12 }] }) }))
vi.mock("@/components/ui/dialog", () => {
  const element = ({ children }: { children: ReactNode }) => createElement("div", null, children)
  return { Dialog: element, DialogContent: element, DialogHeader: element, DialogTitle: element, DialogDescription: element }
})
import { LiveBottomLineControl } from "./live-bottom-line-control"

it("renders live bottom controls and crossing warning without unrelated cooldown edits", () => {
  const hunter = { id: "hunter", name: "枢轴猎手", config: { strategy_version: "hunter-pivot", max_profit_pct: 20, max_loss_pct: 10 }, opportunities: [{ task_id: "task", finished_at: null }] } as Hunter
  const html = renderToStaticMarkup(createElement(LiveBottomLineControl, { hunter }))
  for (const label of ["动态盈亏兜底", "最大收益平仓", "最大止损", "XRPUSDT 当前收益率 -12.00%", "保存并触发平仓", "锁利及枢轴／结构退出继续生效"]) expect(html).toContain(label)
  expect(html).not.toContain("冷静期亏损次数")
})
