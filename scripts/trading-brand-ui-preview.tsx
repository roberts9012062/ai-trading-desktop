/** Isolated actual trading UI. All API and task operations are local fixtures. */
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import "../src/app/globals.css"
import AITradingPage from "@/app/(main)/ai-trading/page"
import { BrandLogo } from "@/components/common/brand-logo"
import { useAuthStore } from "@/stores/auth"
import { useAITradingStore } from "@/stores/ai-trading"
import { useHunterStore } from "@/stores/hunter"
import { useMarketStore } from "@/stores/market"
import { QUANT_KIND_OPTIONS } from "@/lib/quant-strategy"
import type { AITradingTask } from "@/lib/ai-trading-api"
import type { User } from "@/types"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("只允许隔离预览端口5187")
useAuthStore.setState({ user: { id: "brand-preview", username: "设计预览", role: "user", trading_mode: "virtual" } as User, accessToken: "fixture-only" })
localStorage.setItem("access_token", "fixture-only")
globalThis.fetch = async (input, init) => {
  if (init?.method && init.method !== "GET") throw new Error("预览禁止写入外部 API")
  const path = new URL(String(input), location.origin).pathname
  if (path.endsWith("/favorites") || path.endsWith("/task-favorites") || path.endsWith("/strategy-folders")) return Response.json({ items: [] })
  if (path.endsWith("/funding-source")) return Response.json({ source: "site", balance_usdt: 20000, site_balance_usdt: 20000 })
  if (path.endsWith("/capabilities")) return Response.json({ supported_versions: ["hunter-v3"], trading_mode: "virtual", execution_mode: "virtual", can_start: true })
  if (path.includes("session-status")) return Response.json({ is_open: true })
  if (path.endsWith("/indicators")) return Response.json({ indicators: {} })
  return Response.json([])
}
useMarketStore.setState({ initWebSocket: () => {} })
useHunterStore.setState({ groups: [], refresh: async () => {} })
const base = { symbol: "btcusdt", symbol_name: "BTC", timeframe: "15m", status: "paused", position_qty: 0, created_at: new Date().toISOString(), close_rules: {}, stop_rules: {} }
useAITradingStore.setState({
  tasks: QUANT_KIND_OPTIONS.map((option, index) => ({ ...base, id: `preview-${index}`, name: option.label, strategy_type: option.value, icon: option.value === "factor" ? "factor" : "quant" } as AITradingTask)),
  loadTasks: async () => {}, loadEquity: async () => {}, loadProfitBars: async () => {},
  createTask: async payload => ({ ...payload, id: "preview-task" } as AITradingTask),
})
createRoot(document.getElementById("root")!).render(<MemoryRouter>
  <div className="h-screen flex flex-col">
    <header className="h-14 shrink-0 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-6 flex items-center gap-3">
      <BrandLogo size={30} /><span className="text-sm font-semibold">周期领航 · CyclePilot</span><span className="ml-auto text-xs text-[var(--text-muted)]">设计预览 · 模拟数据</span>
    </header>
    <AITradingPage />
  </div>
</MemoryRouter>)
