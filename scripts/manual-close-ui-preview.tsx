/** Isolated UI fixture. All requests are mocked; no real account or order. */
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { TaskList } from "@/components/ai-trading/task-list"
import { EquityLegend } from "@/components/ai-trading/equity/equity-legend"
import { HunterPanel } from "@/components/hunter/hunter-panel"
import { useHunterStore } from "@/stores/hunter"
import type { Hunter } from "@/lib/hunter/api"
import { GlobalDialog } from "@/components/global-dialog"
import { useAITradingStore } from "@/stores/ai-trading"
import { useAuthStore } from "@/stores/auth"
import type { AITradingTask } from "@/lib/ai-trading-api"
import type { User } from "@/types"
import { useState } from "react"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收端口5187")
let requests = 0
const signalExitPreview = location.search.includes("signal_exit=1")
globalThis.fetch = async input => {
  if (String(input).includes("/api/market/session-status")) return Response.json({ is_open: true })
  if (String(input).endsWith("/close-position")) {
    requests++
    document.getElementById("requests")!.textContent = `平仓请求：${requests}`
    await new Promise(resolve => setTimeout(resolve, 1200))
    if (location.search.includes("failure=1")) return Response.json({ detail: "模拟拒单：请重试" }, { status: 502 })
    return Response.json({ task_id: String(input).split("/").at(-2), status: "closing", order_id: "fixture-order", profit_lock_state: { manual_exit: true, closing: true, closed: false } })
  }
  throw new Error("禁止真实API请求：" + String(input))
}
useAuthStore.setState({ user: { id: "manual-close-fixture", username: "隔离验收", trading_mode: "virtual", role: "admin" } as User })
localStorage.setItem("access_token", "fixture-only")
const base = { symbol: "avaxusdt", timeframe: "60m", status: "running", strategy_type: "swing_pivot", position_qty: 90, position_direction: "long", position_avg_price: 10.9, position_last_price: 11.05, position_unrealized: 13.5, has_open_position: true, close_rules: { profit_lock: { enabled: false, mode: "auto", unit: "percent", activation: 3, giveback: 1, cooldown_signals: 2 } }, created_at: new Date().toISOString() } as AITradingTask
useAITradingStore.setState({ tasks: [
  { ...base, id: "held", name: "枢轴 L6/R6/P2 · AVAX · 60m", ...(signalExitPreview ? { profit_lock_state: { signal_exit: true, closing: true } } : {}) },
  { ...base, id: "empty", name: signalExitPreview ? "枢轴量化 · 等待新信号" : "AI 交易 · 当前空仓", strategy_type: signalExitPreview ? "swing_pivot" : "ai", position_qty: 0, has_open_position: false, position_unrealized: 0, ...(signalExitPreview ? { profit_lock_state: { signal_exit: true, closed: true, cooldown_remaining: 0 } } : {}) },
  { ...base, id: "cooldown", name: "因子交易 · 手动锁利冷却", strategy_type: "factor", position_qty: 0, has_open_position: false, position_unrealized: 0, profit_lock_state: { manual_exit: true, closed: true, cooldown_remaining: 2 } },
], loadTasks: async () => {}, loadEquity: async () => {}, loadProfitBars: async () => {} })
useHunterStore.setState({ groups: [{ id: "hunter", name: "猎手验收", status: "running", trading_mode: "virtual", capital: 100, equity: 100,
  config: { venue: "okx", brain: "rules", leverage: 5, margin_mode: "isolated", strategy_version: "hunter-v4", pool_size: 50, cycles: ["short"], whitelist: [], blacklist: [], direction: "both", max_positions: 3, scan_seconds: 60, rule_fallback: true, model_id: null }, runtime: {}, blocks: [],
  stats: { trades: 0, win_rate: null, profit_factor: null, payoff: null }, opportunities: [{ id: "op", task_id: "held", symbol: "avaxusdt", cycle: "short", status: "holding", plan: { entry: 11, stop: 10, direction: "long", quantity: 90 }, runtime: {}, net_profit: 0, finished_at: null }] } as unknown as Hunter], refresh: async () => {} })
function Preview() {
  const tasks = useAITradingStore(s => s.tasks)
  const [selected, setSelected] = useState<string | null>(null)
  return <main className="max-w-6xl mx-auto p-6 space-y-4">
    <h1 className="text-xl">任务卡一键平仓验收</h1><p className="text-sm text-[var(--text-muted)]">点击金色按钮查看提交状态，再模拟成交确认。</p>
    <div id="task-list-fixture"><TaskList tasks={tasks} selectedId={selected} onSelect={setSelected} /></div>
    <details><summary>收益对比任务卡</summary><EquityLegend tasks={tasks} allTasks={tasks} series={{}} profitBars={[]} highlightTaskId={null} onHighlightChange={() => {}} /></details>
    <details id="hunter-preview"><summary>猎手子任务平仓</summary><HunterPanel /></details>
    <button id="confirm-fill" onClick={() => useAITradingStore.setState(s => ({ tasks: s.tasks.map(t => t.id === "held" ? { ...t, position_qty: 0, has_open_position: false, position_unrealized: 0, profit_lock_state: { manual_exit: true, closed: true, cooldown_remaining: 2 } } : t) }))}>模拟全部成交</button>
    <p id="requests">平仓请求：0</p><p>选中卡片：{selected ?? "无"}</p><GlobalDialog />
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
