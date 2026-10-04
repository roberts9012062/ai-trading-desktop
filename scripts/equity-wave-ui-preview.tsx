/** Isolated actual-component fixture; all API calls are intercepted, no exchange or orders. */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { EquityChart } from "@/components/ai-trading/equity/equity-chart"
import { updateEquityTraces, type EquityTraces } from "@/components/ai-trading/equity/equity-wave-data"
import { useAITradingStore } from "@/stores/ai-trading"
import { useAuthStore } from "@/stores/auth"
import type { AITradingTask, ProfitCloseBar } from "@/lib/ai-trading-api"
import type { User } from "@/types"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收端口5187")
let clock = Date.parse("2026-10-04T04:00:00Z"), offline = false
Date.now = () => clock
const opening = clock - 43200000
const owner = { id: "wave-ui-fixture", username: "UI验收", role: "user", trading_mode: "live" } as User
useAuthStore.setState({ user: owner, accessToken: "ui-fixture-only" })
localStorage.setItem("access_token", "ui-fixture-only")
const base = { user_id: owner.id, symbol: "btcusdt", symbol_name: "BTC", timeframe: "5m", position_qty: 1, position_direction: "long", has_open_position: true, position_opened_at: new Date(opening).toISOString(), status: "running", funding_source: "live", strategy_type: "ai", position_avg_price: 65000, close_rules: { pnl_pct: null, total_pnl_pct: null, session_close: false, ai_auto: true }, stop_rules: { loss_pct: null, loss_amount: null, ai_auto: true } }
let fixtureTasks = [
  { ...base, id: "wave-a", name: "模型 A · 趋势持有", model_display_name: "模型 A · 趋势持有", model_id: "gpt-4o" },
  { ...base, id: "wave-b", name: "模型 B · 波段回撤", model_display_name: "模型 B · 波段回撤", model_id: "deepseek-chat" },
  { ...base, id: "wave-c", name: "量化 · 突破策略", model_display_name: "量化 · 突破策略", strategy_type: "ma_cross", model_id: null },
] as AITradingTask[]
let traces: EquityTraces = {}
for (let i = 0; i <= 4320; i++) {
  const step = i / 54
  fixtureTasks = fixtureTasks.map((task, index) => ({ ...task, position_unrealized: index === 0 ? step * .17 + Math.sin(step / 6) * 1.9 : index === 1 ? 6 * Math.sin(step / 15) - step * .015 : 3 * Math.sin(step / 10) + step * .05 }))
  traces = updateEquityTraces(traces, fixtureTasks, opening + i * 10000)
}
useAITradingStore.setState({ tasks: fixtureTasks, equityTraces: traces, waveOwner: JSON.stringify([owner.id, owner.trading_mode]) })
globalThis.fetch = async input => {
  if (String(input).includes("/api/ai-trading/tasks") && !offline) return Response.json({ items: fixtureTasks })
  throw new Error(offline ? "模拟网络中断" : "验收禁止真实API：" + String(input))
}
async function refresh(seconds = 1) { clock += seconds * 1000; await useAITradingStore.getState().loadTasks({ silent: true }) }

function Preview() {
  const tasks = useAITradingStore(s => s.tasks), waves = useAITradingStore(s => s.equityTraces)
  const [visible, setVisible] = useState(true)
  const bars = tasks.map(task => ({ id: task.id, task_id: task.id, task_name: task.name, model_display_name: task.model_display_name, model_id: task.model_id, strategy_type: task.strategy_type, symbol: task.symbol, symbol_name: task.symbol_name, timeframe: task.timeframe, unrealized: task.position_unrealized, realized: 5, total_pnl: 5 + (task.position_unrealized ?? 0), cumulative: 5 + (task.position_unrealized ?? 0), has_open_position: (task.position_qty ?? 0) > 0, status: task.status })) as unknown as ProfitCloseBar[]
  return <main className="mx-auto max-w-[1500px] p-4 space-y-4">
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
      <span className="mr-auto">持仓波段隔离验收 · 使用模拟样本</span>
      <button onClick={() => { fixtureTasks = fixtureTasks.map(t => ({ ...t, position_unrealized: (t.position_unrealized ?? 0) + .2 })); void refresh() }}>推进一次浮盈</button>
      <button onClick={() => { fixtureTasks = fixtureTasks.map(t => t.id === "wave-a" ? { ...t, position_qty: 0, position_direction: null, has_open_position: false, position_unrealized: 0 } : t); void refresh() }}>完整平仓模型 A</button>
      <button onClick={() => { fixtureTasks = fixtureTasks.map(t => t.id === "wave-a" ? { ...t, position_qty: 1, position_direction: "long", has_open_position: true, position_opened_at: new Date(clock).toISOString(), position_unrealized: -.15 } : t); void refresh() }}>重新开仓模型 A</button>
      <button onClick={() => { offline = true; void refresh(20) }}>模拟网络中断</button>
      <button onClick={() => { offline = false; void refresh() }}>恢复报价</button>
      <button onClick={() => setVisible(!visible)}>隐藏/恢复图表</button>
      <button onClick={() => { clock = Date.parse("2026-10-04T16:00:01Z"); document.dispatchEvent(new Event("visibilitychange")); void refresh() }}>推进到次日00:00</button>
    </div>
    {visible && <EquityChart tasks={tasks} series={{}} traces={waves} profitBars={bars} />}
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
