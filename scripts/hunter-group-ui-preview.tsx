import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { HunterPanel } from "@/components/hunter/hunter-panel"
import { ProfitBarChart } from "@/components/ai-trading/profit/profit-bar-chart"
import { EquityLegend } from "@/components/ai-trading/equity/equity-legend"
import { useAITradingStore } from "@/stores/ai-trading"
import { useHunterStore } from "@/stores/hunter"
import type { AITradingTask, ProfitCloseBar } from "@/lib/ai-trading-api"
import type { Hunter, Opportunity } from "@/lib/hunter/api"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收5187")
globalThis.fetch = async () => { throw new Error("分组验收禁止真实API") }
const tasks = [12, -3, 8].map((value, i) => ({ id: "child-" + i, name: "猎手币种 " + i, strategy_type: "multi_cycle_hunter", strategy_params: {hunter_id: "preview-hunter"}, symbol: ["btcusdt", "ethusdt", "solusdt"][i], symbol_name: ["BTC", "ETH", "SOL"][i], timeframe: "5m", position_qty: 1, position_direction: "long", position_unrealized: value, close_rules: { profit_lock: {enabled: true}}, profit_lock_state: {activated: true, locked_net: 5, net_profit: value, peak_net: 10, margin: 100}, status: "running" })) as AITradingTask[]
const bars = tasks.map(task => ({ task_id: task.id, task_name: task.name, symbol: task.symbol, symbol_name: task.symbol_name, strategy_type: task.strategy_type, realized: 10, unrealized: task.position_unrealized, total_pnl: 10 + (task.position_unrealized ?? 0), has_open_position: true, status: "running" })) as ProfitCloseBar[]
const opportunities = tasks.map((task, i) => ({ id: "op-" + i, task_id: task.id, symbol: task.symbol, cycle: "short", status: "holding", finished_at: null, net_profit: 10, plan: {entry: 100, stop: 97, quantity: 1, direction: "long", leverage: 5, margin_mode: "isolated", version: "hunter-v4", target_price: 110, min_net_rr: 3}, runtime: {stop: 105, entry: 100, unrealized: task.position_unrealized, swing: {regime: "trend", reason: "趋势延续，继续持有"}} })) as Opportunity[]
const hunter = { id: "preview-hunter", name: "AI 多周期猎手", status: "running", trading_mode: "live", capital: 1000, equity: 1047, config: {venue: "okx", leverage: 5, margin_mode: "isolated", brain: "rules", strategy_version: "hunter-v4", pool_size: 50, cycles: ["short", "medium", "long"]}, runtime: {realized: 30, unrealized: 17, execution_account: {execution_mode: "okx_demo"}}, stats: {trades: 3, win_rate: 2/3, profit_factor: 3.5, payoff: 3}, blocks: [], opportunities } as Hunter
useAITradingStore.setState({tasks})
useHunterStore.setState({ groups: [hunter], refresh: async () => {} })
function Preview() {
  const currentTasks = useAITradingStore(s => s.tasks)
  const groups = useHunterStore(s => s.groups)
  return <main className="mx-auto max-w-6xl p-5 space-y-4">
    <div className="flex justify-between text-xs text-[var(--text-muted)]"><span>猎手分组 · 隔离模拟数据</span><button onClick={() => { useHunterStore.setState({groups: [{...hunter, runtime: {...hunter.runtime}}]}); useAITradingStore.setState({tasks: tasks.map(t => ({...t}))}) }}>模拟轮询</button></div>
    <HunterPanel />
    <ProfitBarChart items={bars} totalRealized={30} totalUnrealized={17} totalPnl={47} openPositionCount={3} loading={false} hunters={groups} tasks={currentTasks} />
    <EquityLegend tasks={currentTasks} series={{}} profitBars={bars} hunters={groups} highlightTaskId={null} onHighlightChange={() => {}} />
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
