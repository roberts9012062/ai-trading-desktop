/** Isolated shared-form fixture; never contacts a server or creates an order. */
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateTaskRules, EMPTY_RULE_FORM, buildCloseRulesPayload, buildBottomPayload, rulesFromTask } from "@/components/ai-trading/form/create-task-rules"
import { Button } from "@/components/ui/button"
import { useAuthStore } from "@/stores/auth"
import { useAITradingStore } from "@/stores/ai-trading"
import type { User } from "@/types"
import type { AITradingTask } from "@/lib/ai-trading-api"
import type { Champion } from "@/lib/factor-lab-api"
import { SelectedFactorPanel } from "@/components/factor-lab/panels/selected-factor-panel"
import { CreateFromFavoriteDialog } from "@/components/ai-trading/create-from-favorite-dialog"
import { templateFixture } from "./profit-lock-template-fixture"
import { TaskActions } from "@/components/ai-trading/task-actions"
import AITradingPage from "@/app/(main)/ai-trading/page"
import { MemoryRouter } from "react-router-dom"
import { useMarketStore } from "@/stores/market"
import { useHunterStore } from "@/stores/hunter"
import type { Hunter } from "@/lib/hunter/api"
import { updateEquityTraces } from "@/components/ai-trading/equity/equity-wave-data"
if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("只能在隔离验收端口5187运行")
useAuthStore.setState({ user: { id: "ui-fixture", username: "UI验收", role: "admin", trading_mode: "virtual" } as User, accessToken: "ui-fixture-only" })
localStorage.setItem("access_token", "ui-fixture-only")
let failHotSave = new URLSearchParams(location.search).get("failure") === "1"
globalThis.fetch = async (input, init) => {
  if (String(input).includes("/api/market/session-status?")) return Response.json({ is_open: true })
  if (String(input).endsWith("/profit-lock") && String(input).includes("/api/ai-trading/tasks/")) {
    if (failHotSave) { failHotSave = false; return Response.json({ detail: "模拟保存失败，请重试" }, { status: 503 }) }
    const body = JSON.parse(String(init?.body))
    document.getElementById("submitted")!.textContent = JSON.stringify(body)
    return Response.json({ id: String(input).split("/").at(-2), profit_lock: body.profit_lock })
  }
  if (String(input).endsWith("/profit-lock") && String(input).includes("/api/hunter/groups/")) {
    const body = JSON.parse(String(init?.body))
    document.getElementById("submitted")!.textContent = JSON.stringify(body)
    return Response.json({ id: "fixture-hunter", profit_lock: body.profit_lock, affected_tasks: 0 })
  }
  const templates = templateFixture(input, init)
  if (templates) return templates
  if (String(input).endsWith("/api/ai-trading/task-favorites")) return Response.json({ items: [{ id: "fixture-favorite", snapshot: { name: "收藏任务验收", symbol: "btcusdt", timeframe: "15m", strategy_type: "ma_cross", close_rules: { pnl_pct: 6, ai_auto: false, profit_lock: { enabled: true, mode: "manual", unit: "usdt", activation: 10, giveback: 2, cooldown_signals: 3 } } } }] })
  throw new Error("锁利界面验收禁止真实API请求：" + String(input))
}
function HeaderPreview() {
  const [ready, setReady] = useState(false)
  const tasks = useAITradingStore(s => s.tasks)
  const groups = useHunterStore(s => s.groups)
  useEffect(() => {
    useMarketStore.setState({ initWebSocket: () => {} })
    const base = { symbol: "btcusdt", symbol_name: "BTC", timeframe: "15m", status: "running", strategy_type: "ai", position_qty: 0, position_direction: null, created_at: new Date().toISOString(), close_rules: { pnl_pct: 77, total_pnl_pct: null, session_close: false, ai_auto: true }, stop_rules: { loss_pct: 10, loss_amount: null, ai_auto: false } }
    useAITradingStore.setState({ tasks: new URLSearchParams(location.search).has("empty") ? [] : [
      { ...base, id: "fixture-live-task", name: "AI任务验收" } as AITradingTask,
      { ...base, id: "fixture-quant-task", name: "量化任务验收", strategy_type: "ma_cross" } as AITradingTask,
    ], selectedTaskId: null, loadTasks: async () => {}, loadEquity: async () => {}, loadProfitBars: async () => {} })
    if (new URLSearchParams(location.search).has("polling")) {
      const hunterOnly = new URLSearchParams(location.search).has("hunter-only")
      if (hunterOnly) useAITradingStore.setState({tasks: []})
      const counts = { tasks: 0, equity: 0, profit: 0 }
      Object.assign(window, { wavePollCounts: counts })
      useAITradingStore.setState({
        loadTasks: async () => { counts.tasks++; useAITradingStore.setState(s => {
          const nextTasks = hunterOnly && counts.tasks >= 3 ? [{...base,id:"mounted-hunter-child",name:"新挂载AXS空单",strategy_type:"multi_cycle_hunter",position_qty:2,position_direction:"short",position_avg_price:5,position_last_price:4.8,position_unrealized:.37,position_opened_at:base.created_at} as AITradingTask] : s.tasks.map(t => ({ ...t, note: String(counts.tasks) }))
          return {tasks:nextTasks,...(hunterOnly ? {equityTraces:updateEquityTraces(s.equityTraces,nextTasks,Date.now())} : {})}
        }) },
        loadEquity: async () => { counts.equity++ },
        loadProfitBars: async () => { counts.profit++ },
      })
    }
    useHunterStore.setState({ groups: new URLSearchParams(location.search).has("empty") ? [] : [{ id: "fixture-hunter", name: "多周期猎手验收", status: "running", trading_mode: "virtual", config: { venue: "okx", leverage: 5, margin_mode: "isolated", brain: "rules", strategy_version: "hunter-v2" }, capital: 100, equity: 100, blocks: [], runtime: {}, stats: { trades: 0, win_rate: null, profit_factor: null, payoff: null }, opportunities: [] } as unknown as Hunter], refresh: async () => {} })
    const poll = () => useAITradingStore.setState(s => ({ tasks: s.tasks.map(t => ({ ...t, note: "模拟轮询" })) }))
    const remove = () => { useAITradingStore.setState({ tasks: [] }); useHunterStore.setState({ groups: [] }) }
    const changeAccount = () => useAuthStore.setState({ user: { id: "another-fixture-user", username: "另一个验收账户", role: "user", trading_mode: "virtual" } as User })
    const lockUpdate = (event: Event) => useAITradingStore.setState(s => ({ tasks: s.tasks.map(t => t.id === "fixture-live-task" ? { ...t, ...((event as CustomEvent).detail ?? {}) } : t) }))
    window.addEventListener("fixture-task-poll", poll)
    window.addEventListener("fixture-remove-targets", remove)
    window.addEventListener("fixture-account-change", changeAccount)
    window.addEventListener("fixture-lock-update", lockUpdate)
    setReady(true)
    return () => { window.removeEventListener("fixture-task-poll", poll); window.removeEventListener("fixture-remove-targets", remove); window.removeEventListener("fixture-account-change", changeAccount); window.removeEventListener("fixture-lock-update", lockUpdate) }
  }, [])
  // Wait for fixture-only store methods before mounting the actual page.
  if (!ready) return <p>验收准备中</p>
  return <MemoryRouter><AITradingPage /><pre id="submitted" className="text-xs whitespace-pre-wrap break-all" /><pre id="current-task" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify({ tasks, groups }, null, 2)}</pre></MemoryRouter>
}
function LivePreview() {
  const tasks = useAITradingStore(s => s.tasks)
  useEffect(() => {
    useAITradingStore.setState({ tasks: [{ id: "fixture-live-task", name: "运行持仓验收", symbol: "btcusdt", status: "running", strategy_type: new URLSearchParams(location.search).get("strategy") ?? "ai", can_edit: false, can_edit_rules: false, position_direction: "long", position_qty: 1, position_margin: 100, close_rules: { pnl_pct: 77, total_pnl_pct: null, session_close: false, ai_auto: true }, stop_rules: { loss_pct: 10, loss_amount: null, ai_auto: false }, profit_lock_state: { locked_net: 8, peak_net: 10 } } as AITradingTask] })
    const poll = () => useAITradingStore.setState(s => ({ tasks: s.tasks.map(task => ({ ...task, note: "模拟轮询更新" })) }))
    window.addEventListener("fixture-task-poll", poll)
    return () => window.removeEventListener("fixture-task-poll", poll)
  }, [])
  return <main className="max-w-lg mx-auto p-4 space-y-4">
    <h1>运行中 · 有持仓 · 隔离验收</h1>
    {tasks.map(task => <TaskActions key={task.id} task={task} compact />)}
    <Button type="button" onClick={() => window.dispatchEvent(new Event("fixture-task-poll"))}>模拟任务轮询</Button>
    <pre id="submitted" className="text-xs whitespace-pre-wrap break-all" />
    <pre id="current-task" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(tasks[0], null, 2)}</pre>
  </main>
}
function Preview() {
  const [rules,setRules] = useState(EMPTY_RULE_FORM)
  const [ai,setAi] = useState(true)
  const [output,setOutput] = useState("")
  const [error,setError] = useState("")
  const entry = new URLSearchParams(location.search).get("entry")
  useEffect(() => { useAITradingStore.setState({ createTask: async payload => { setOutput(JSON.stringify(payload, null, 2)); return { ...payload, id: "fixture-task" } as AITradingTask } }) }, [])
  if (entry === "live") return <LivePreview />
  if (entry === "header") return <HeaderPreview />
  if (entry === "favorite") return <><CreateFromFavoriteDialog open onClose={() => {}} /><pre id="submitted">{output}</pre></>
  if (entry === "factor") return <main className="max-w-lg mx-auto p-4"><SelectedFactorPanel selected={{ tokens: [1], text: "因子验收", composite: 1, metrics: { ann_ret: .1, sortino: 1, ts_ic: .1, max_dd: .1, n_trades: 10 } } as Champion} bt={null} btLoading={false} building={false} buildMsg={null} onFavorite={() => {}} onCopyTokens={() => {}} onBuildTask={profit_lock => setOutput(JSON.stringify({ profit_lock }))} /><pre id="submitted">{output}</pre></main>
  return <main className="mx-auto max-w-lg p-4 space-y-4">
    <h1 className="text-lg">锁利润 · 隔离验收</h1>
    <label className="flex gap-2"><input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} />AI类型（取消即量化类型）</label>
    <CreateTaskRules value={rules} onChange={setRules} showAiOptions={ai} showLifecycle={false} />
    <p id="form-error" role="alert">{error}</p>
    <Button onClick={() => { try { buildBottomPayload(rules); const close_rules = buildCloseRulesPayload(rules,ai); setOutput(JSON.stringify(close_rules,null,2)); setRules(rulesFromTask({close_rules,max_profit_pct:20,max_loss_pct:10})); setError("") } catch (e) { setError(String((e as Error).message)) } }}>保存并模拟编辑回填</Button>
    <pre id="submitted" className="text-xs whitespace-pre-wrap">{output}</pre>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
