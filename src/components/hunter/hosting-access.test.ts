import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, it, vi } from "vitest"
import type { Hunter } from "@/lib/hunter/api"

const fixture = vi.hoisted(() => ({ role: "user", groups: [] as Hunter[] }))
vi.mock("@/stores/auth", () => ({ useAuthStore: Object.assign((select: (s: unknown) => unknown) => select({ user: { role: fixture.role, trading_mode: "virtual" } }), { subscribe: vi.fn() }) }))
vi.mock("@/stores/hunter", () => ({ useHunterStore: (select: (s: unknown) => unknown) => select({ groups: fixture.groups, progress: {}, watches: {}, create: vi.fn(), control: vi.fn(), setProfitLock: vi.fn(), setHosting: vi.fn() }) }))
vi.mock("@/components/ui/dialog", () => {
  const element = ({ children }: { children: ReactNode }) => createElement("div", null, children)
  return { Dialog: element, DialogContent: element, DialogHeader: element, DialogTitle: element, DialogDescription: element, DialogFooter: element }
})
import { CreateHunterDialog } from "./create-hunter-dialog"
import { HunterPanel } from "./hunter-panel"

beforeEach(() => { fixture.role = "user"; fixture.groups = [] })

it("shows only local scanning when a user creates a hunter", () => {
  const html = renderToStaticMarkup(createElement(CreateHunterDialog, { open: true, onClose: vi.fn() }))
  expect(html).toContain("本机扫描")
  expect(html).not.toContain('value="server"')
  expect(html).not.toContain("服务器托管")
  expect(html).toContain("普通用户每个猎手最多同时运行 3 个交易子任务")
  expect(html).toContain("最多同时运行的交易子任务（1～3）")
  expect(html).toMatch(/id="hunter-slots"[^>]*value="3"/)
})

it("keeps the server hosting choice visible for administrators", () => {
  fixture.role = "admin"
  const html = renderToStaticMarkup(createElement(CreateHunterDialog, { open: true, onClose: vi.fn() }))
  expect(html).toContain('value="server"')
  expect(html).toContain("服务器托管 · 仅管理员")
  expect(html).toContain("最多同时运行的交易子任务（1～4）")
  expect(html).toMatch(/id="hunter-slots"[^>]*value="4"/)
})

it("hides the running hunter hosting button for users but shows it for administrators", () => {
  fixture.groups = [{ id: "hunter", name: "本机猎手", status: "running", trading_mode: "virtual", capital: 1000, equity: 1000,
    config: { name: "本机猎手", strategy_version: "hunter-v4", venue: "okx", cycles: ["short"], leverage: 1, margin_mode: "isolated", scan_location: "desktop", brain: "rules", model_id: null, rule_fallback: false, direction: "both", whitelist: [], blacklist: [], pool_size: 50, max_positions: 4, scan_seconds: 60 },
    blocks: [], runtime: {}, stats: { trades: 0, win_rate: null, profit_factor: null, payoff: null }, opportunities: [] }]
  const user = renderToStaticMarkup(createElement(HunterPanel))
  expect(user).not.toContain("挂载到服务器")
  fixture.role = "admin"
  const admin = renderToStaticMarkup(createElement(HunterPanel))
  expect(admin).toContain("挂载到服务器 · 管理员")
})
