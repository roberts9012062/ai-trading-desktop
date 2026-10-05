import { createRoot } from "react-dom/client"
import { useState } from "react"
import PositionsPage from "@/app/(main)/positions/page"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { useMarketStore } from "@/stores/market"
import type { PaperPositionItem } from "@/lib/paper-api"
import "../src/app/globals.css"
import { HunterPanel } from "@/components/hunter/hunter-panel"
import { ProfitBarChart } from "@/components/ai-trading/profit/profit-bar-chart"
import { EquityLegend } from "@/components/ai-trading/equity/equity-legend"
import { useAITradingStore } from "@/stores/ai-trading"
import { useHunterStore } from "@/stores/hunter"
import type { AITradingTask, ProfitCloseBar } from "@/lib/ai-trading-api"
import type { Hunter, Opportunity } from "@/lib/hunter/api"
import { TaskWatchList } from "@/components/ai-market/task-watch-list"
import { useAiMarketStore } from "@/stores/ai-market"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收5187")
globalThis.fetch = async () => { throw new Error("分组验收禁止真实API") }
const tasks = [12, -3, 8].map((value, i) => ({ id: "child-" + i, name: "猎手币种 " + i, strategy_type: "multi_cycle_hunter", strategy_params: {hunter_id: "preview-hunter"}, symbol: ["btcusdt", "ethusdt", "solusdt"][i], symbol_name: ["BTC", "ETH", "SOL"][i], timeframe: "5m", position_qty: 1, position_direction: "long", position_unrealized: value, close_rules: { profit_lock: {enabled: true}}, profit_lock_state: {activated: true, locked_net: 5, net_profit: value, peak_net: 10, margin: 100}, status: "running" })) as AITradingTask[]
const bars = tasks.map(task => ({ task_id: task.id, task_name: task.name, symbol: task.symbol, symbol_name: task.symbol_name, strategy_type: task.strategy_type, realized: 10, unrealized: task.position_unrealized, total_pnl: 10 + (task.position_unrealized ?? 0), has_open_position: true, status: "running" })) as ProfitCloseBar[]
const opportunities = tasks.map((task, i) => ({ id: "op-" + i, task_id: task.id, symbol: task.symbol, cycle: "short", status: "holding", finished_at: null, net_profit: 10, plan: {entry: 100, stop: 97, quantity: 1, direction: "long", leverage: 5, margin_mode: "isolated", version: "hunter-v4", target_price: 110, min_net_rr: 3}, runtime: {stop: 105, entry: 100, unrealized: task.position_unrealized, swing: {regime: "trend", reason: "趋势延续，继续持有"}} })) as Opportunity[]
const hunter = { id: "preview-hunter", name: "AI 多周期猎手", status: "running", trading_mode: "live", capital: 1000, equity: 1047, config: {venue: "okx", leverage: 5, margin_mode: "isolated", brain: "rules", strategy_version: "hunter-v4", pool_size: 50, cycles: ["short", "medium", "long"]}, runtime: {realized: 30, unrealized: 17, execution_account: {execution_mode: "okx_demo"}}, stats: {trades: 3, win_rate: 2/3, profit_factor: 3.5, payoff: 3}, blocks: [], opportunities } as Hunter
useAITradingStore.setState({tasks})
useHunterStore.setState({ groups: [hunter], refresh: async () => {} })
function Preview() {
  const [selected,setSelected] = useState("")
  const currentTasks = useAITradingStore(s => s.tasks)
  const groups = useHunterStore(s => s.groups)
  const viewBars = bars.map(bar => currentTasks.find(task => task.id === bar.task_id)?.status === "stopped" ? {...bar,status:"stopped",has_open_position:false,realized:bar.total_pnl,unrealized:0} : bar)
  return <main className="mx-auto max-w-6xl p-5 space-y-4">
    <div className="flex justify-between text-xs text-[var(--text-muted)]"><span>猎手分组 · 隔离模拟数据</span><button onClick={() => { useHunterStore.setState({groups: [{...hunter, runtime: {...hunter.runtime}}]}); useAITradingStore.setState({tasks: tasks.map(t => ({...t}))}) }}>模拟轮询</button></div>
    <button onClick={() => {
      useAITradingStore.setState({tasks: currentTasks.map(t => t.id === "child-1" ? {...t,status:"stopped",position_qty:0,position_direction:null,position_unrealized:0,has_open_position:false} : t)})
      useHunterStore.setState({groups: groups.map(g => ({...g,opportunities:g.opportunities.map(o => o.task_id === "child-1" ? {...o,finished_at:new Date().toISOString(),status:"closed"} : o)}))})
    }}>模拟ETH结束</button>
    <HunterPanel onSelectTask={setSelected} /><output data-testid="selected-hunter-task">{selected}</output>
    <ProfitBarChart items={viewBars} totalRealized={viewBars.reduce((s,b)=>s+(b.realized??0),0)} totalUnrealized={viewBars.reduce((s,b)=>s+(b.unrealized??0),0)} totalPnl={47} openPositionCount={currentTasks.filter(t=>(t.position_qty??0)>0).length} loading={false} hunters={groups} tasks={currentTasks} />
    <EquityLegend tasks={currentTasks.filter(t=>(t.position_qty??0)>0)} allTasks={currentTasks} series={{}} profitBars={viewBars} hunters={groups} highlightTaskId={null} onHighlightChange={() => {}} />
  </main>
}
if (new URLSearchParams(location.search).has("positions")) {
  useAITradingStore.setState({loadTasks:async()=>{}})
  useMarketStore.setState({quotes:{}})
  usePaperTradingStore.setState({mode:"live",refresh:async()=>{},positions:[{id:"axsholding",symbol:"axsusdt",symbol_name:"AXS",direction:"short",source:"quant",task_name:"AI多周期猎手·axsusdt·short",task_id:"axstask",quantity:2,available_quantity:2,avg_price:5,mark_price:4.8,unrealized_pnl:.37,margin:2,multiplier:1,leverage:5,margin_mode:"isolated"} as PaperPositionItem]})
}
let watchingRows = tasks.map(t => ({ ...t }))
function WatchPreview() {
  const selected = useAiMarketStore(s => s.selectedTaskId)
  return <main className="p-5 space-y-3">
    <p>AI 看盘 · 猎手结束清理 · 隔离模拟数据</p>
    <button onClick={() => {
      watchingRows = watchingRows.map(t => ({ ...t, status: "stopped", position_qty: 0, has_open_position: false }))
      void useAiMarketStore.getState().loadTasks(true)
    }}>模拟猎手全部平仓结束</button>
    <div className="h-[500px] w-[320px]"><TaskWatchList /></div>
    <output data-testid="watch-selected">{selected ?? "未选中任务"}</output>
  </main>
}
const watchPreview = new URLSearchParams(location.search).has("watch")
if (watchPreview) {
  // Use real task loading/selection with fake API responses; never touch a live account.
  globalThis.fetch = async input => {
    const path = String(input)
    if (path.endsWith("/api/ai-trading/tasks")) return Response.json({ items: watchingRows, total: watchingRows.length })
    if (/\/api\/ai-trading\/tasks\/child-\d\/.*$/.test(path)) return Response.json({ items: [] })
    throw new Error("看盘清理验收禁止真实API")
  }
}
createRoot(document.getElementById("root")!).render(watchPreview ? <WatchPreview /> : new URLSearchParams(location.search).has("positions") ? <PositionsPage /> : <Preview />)
