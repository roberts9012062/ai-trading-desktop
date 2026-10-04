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
    return Response.json({ id: "fixture-live-task", profit_lock: body.profit_lock })
  }
  const templates = templateFixture(input, init)
  if (templates) return templates
  if (String(input).endsWith("/api/ai-trading/task-favorites")) return Response.json({ items: [{ id: "fixture-favorite", snapshot: { name: "收藏任务验收", symbol: "btcusdt", timeframe: "15m", strategy_type: "ma_cross", close_rules: { pnl_pct: 6, ai_auto: false, profit_lock: { enabled: true, mode: "manual", unit: "usdt", activation: 10, giveback: 2, cooldown_signals: 3 } } } }] })
  throw new Error("锁利界面验收禁止真实API请求：" + String(input))
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
