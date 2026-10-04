/** Isolated UI fixture: intercepts every API call; never mounts a real task. */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateHunterDialog } from "@/components/hunter/create-hunter-dialog"
import { HunterPanel } from "@/components/hunter/hunter-panel"
import { useAuthStore } from "@/stores/auth"
import { useHunterStore } from "@/stores/hunter"
import type { User } from "@/types"
import type { Hunter, HunterConfig } from "@/lib/hunter/api"
import { Button } from "@/components/ui/button"
import { templateFixture } from "./profit-lock-template-fixture"

let groups: Hunter[] = []
let nextHunter = 0
if (location.hostname !== "127.0.0.1" || location.port !== "5187") {
  throw new Error("界面验收仅允许隔离地址 127.0.0.1:5187，防止覆盖正常登录状态")
}
const executionMode = new URLSearchParams(location.search).get("account") === "okx_demo" ? "okx_demo" : "virtual"
const tradingMode = executionMode === "okx_demo" ? "live" : "virtual"
const user = { id: "ui-fixture", username: "UI 验收", role: "admin", trading_mode: tradingMode } as User
useAuthStore.setState({ user, accessToken: "ui-fixture-only" })
localStorage.setItem("access_token", "ui-fixture-only")
globalThis.fetch = async (input, init) => {
  const templates = templateFixture(input, init)
  if (templates) return templates
  const url = String(input)
  if (url.endsWith("/api/ai-trading/tasks")) return Response.json({ items: [], total: 0 })
  if (url.endsWith("/profit-lock") && url.includes("/api/hunter/groups/")) {
    const body = JSON.parse(String(init?.body))
    groups[0].config = { ...groups[0].config, profit_lock: body.profit_lock }
    document.getElementById("submitted")!.textContent = JSON.stringify(body)
    return Response.json({ id: groups[0].id, profit_lock: body.profit_lock, affected_tasks: 0 })
  }
  if (url.endsWith("/api/hunter/symbols")) return Response.json([
    { symbol: "btcusdt", name: "BTC / USDT" }, { symbol: "ethusdt", name: "ETH / USDT" },
    { symbol: "solusdt", name: "SOL / USDT" }, { symbol: "dogeusdt", name: "DOGE / USDT" },
  ])
  if (url.endsWith("/capabilities")) return Response.json({ supported_versions: ["hunter-v1", "hunter-v2", "hunter-v3", "hunter-v4"], live_qualified: false, trading_mode: tradingMode, execution_mode: executionMode, can_start: true, reason: "" })
  if (url.endsWith("/api/ai/models")) return Response.json([
    { id: "fixture-chat", display_name: "验收大模型", capabilities: ["chat"], provider_api_type: "openai" },
    { id: "fixture-jev", display_name: "验收 Jev", capabilities: ["decision"], provider_api_type: "jev" },
  ])
  if (url.endsWith("/groups")) {
    if (init?.method === "POST") {
      const config = JSON.parse(String(init.body)) as HunterConfig
      groups = [{ id: "fixture-hunter-" + (++nextHunter), name: config.name, status: "running", trading_mode: tradingMode,
        config, capital: config.capital, equity: config.capital, blocks: [], runtime: { execution_account: { execution_mode: executionMode } },
        stats: { trades: 0, win_rate: null, profit_factor: null, payoff: null }, opportunities: [] }]
      document.getElementById("submitted")!.textContent = JSON.stringify(config, null, 2)
      return Response.json(groups[0])
    }
    return Response.json(groups)
  }
  if (url.endsWith("/control")) {
    const { action, pool_size } = JSON.parse(String(init?.body))
    if (action === "upgrade_adaptive") groups[0].config.strategy_version = "hunter-v3"
    else if (action === "upgrade_swing") groups[0].config.strategy_version = "hunter-v4"
    else if (action === "upgrade") groups[0].config.strategy_version = "hunter-v2"
    else groups[0].status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped"
    if (pool_size !== undefined) groups[0].config.pool_size = pool_size
    document.getElementById("submitted")!.textContent = JSON.stringify({ action, pool_size })
    return Response.json(groups[0])
  }
  throw new Error("界面验收禁止外部 API：" + url)
}
function Preview() {
  const [open, setOpen] = useState(false)
  const hunterExists = useHunterStore(s => s.groups.some(g => g.status !== "stopped"))
  return <main className="p-6 space-y-5 max-w-5xl mx-auto">
    <p className="text-xs text-[var(--text-muted)]">隔离界面验收 · 全部 API 使用本地夹具</p>
    <div className="flex gap-2"><Button>创建 AI 交易</Button><Button variant="outline" disabled={hunterExists} onClick={() => setOpen(true)}>创建多周期猎手</Button></div>
    <HunterPanel />
    <CreateHunterDialog open={open} onClose={() => setOpen(false)} />
    <details><summary>已提交参数</summary><pre id="submitted" className="text-xs whitespace-pre-wrap" /></details>
  </main>
}
window.addEventListener("fixture-hunter-report", ((event: CustomEvent<Hunter["runtime"]["discovery"]>) => {
  if (groups[0]) { groups[0] = { ...groups[0], runtime: { ...groups[0].runtime, discovery: event.detail } }; useHunterStore.setState({ groups: [...groups] }) }
}) as EventListener)
window.addEventListener("fixture-hunter-opportunities", ((event: CustomEvent<Hunter["opportunities"]>) => {
  if (groups[0]) { groups[0] = { ...groups[0], opportunities: event.detail }; useHunterStore.setState({ groups: [...groups] }) }
}) as EventListener)
createRoot(document.getElementById("root")!).render(<Preview />)
