/** Isolated UI fixture: intercepts every API call; never mounts a real task. */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateHunterDialog } from "@/components/hunter/create-hunter-dialog"
import { HunterPanel } from "@/components/hunter/hunter-panel"
import { useAuthStore } from "@/stores/auth"
import type { User } from "@/types"
import type { Hunter, HunterConfig } from "@/lib/hunter/api"
import { Button } from "@/components/ui/button"

let groups: Hunter[] = []
if (location.hostname !== "127.0.0.1" || location.port !== "5187") {
  throw new Error("界面验收仅允许隔离地址 127.0.0.1:5187，防止覆盖正常登录状态")
}
const executionMode = new URLSearchParams(location.search).get("account") === "okx_demo" ? "okx_demo" : "virtual"
const tradingMode = executionMode === "okx_demo" ? "live" : "virtual"
const user = { id: "ui-fixture", username: "UI 验收", role: "admin", trading_mode: tradingMode } as User
useAuthStore.setState({ user, accessToken: "ui-fixture-only" })
localStorage.setItem("access_token", "ui-fixture-only")
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith("/api/hunter/symbols")) return Response.json([
    { symbol: "btcusdt", name: "BTC / USDT" }, { symbol: "ethusdt", name: "ETH / USDT" },
    { symbol: "solusdt", name: "SOL / USDT" }, { symbol: "dogeusdt", name: "DOGE / USDT" },
  ])
  if (url.endsWith("/capabilities")) return Response.json({ live_qualified: false, trading_mode: tradingMode, execution_mode: executionMode, can_start: true, reason: "" })
  if (url.endsWith("/api/ai/models")) return Response.json([
    { id: "fixture-chat", display_name: "验收大模型", capabilities: ["chat"], provider_api_type: "openai" },
    { id: "fixture-jev", display_name: "验收 Jev", capabilities: ["decision"], provider_api_type: "jev" },
  ])
  if (url.endsWith("/groups")) {
    if (init?.method === "POST") {
      const config = JSON.parse(String(init.body)) as HunterConfig
      groups = [{ id: "fixture-hunter", name: config.name, status: "running", trading_mode: tradingMode,
        config, capital: config.capital, equity: config.capital, blocks: [], runtime: { execution_account: { execution_mode: executionMode } },
        stats: { trades: 0, win_rate: null, profit_factor: null, payoff: null }, opportunities: [] }]
      document.getElementById("submitted")!.textContent = JSON.stringify(config, null, 2)
      return Response.json(groups[0])
    }
    return Response.json(groups)
  }
  if (url.endsWith("/control")) {
    const { action } = JSON.parse(String(init?.body))
    groups[0].status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped"
    return Response.json(groups[0])
  }
  throw new Error("界面验收禁止外部 API：" + url)
}
function Preview() {
  const [open, setOpen] = useState(false)
  return <main className="p-6 space-y-5 max-w-5xl mx-auto">
    <p className="text-xs text-[var(--text-muted)]">隔离界面验收 · 全部 API 使用本地夹具</p>
    <div className="flex gap-2"><Button>创建 AI 交易</Button><Button variant="outline" onClick={() => setOpen(true)}>创建多周期猎手</Button></div>
    <HunterPanel />
    <CreateHunterDialog open={open} onClose={() => setOpen(false)} />
    <details><summary>已提交参数</summary><pre id="submitted" className="text-xs whitespace-pre-wrap" /></details>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
