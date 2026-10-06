/** Read-only UI fixture: no login, account, API, storage or execution. */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateTaskRules, EMPTY_RULE_FORM, buildBottomPayload } from "@/components/ai-trading/form/create-task-rules"
import { TaskLossCooldownStatus } from "@/components/ai-trading/loss-cooldown-status"
import type { AITradingTask } from "@/lib/ai-trading-api"

function Preview() {
  const [rules,setRules] = useState(EMPTY_RULE_FORM)
  const [message,setMessage] = useState("")
  const sample = { loss_cooldown_enabled: true, loss_cooldown_limit: 2,
    loss_cooldown_state: { enabled: true, limit: 2, loss_count: 2, active: true, reset_at: "2026-10-06T22:00:00Z" } } as AITradingTask
  return <main className="max-w-2xl mx-auto p-6 space-y-3">
    <h1 className="text-lg font-medium">亏损冷静期 · 隔离验收</h1>
    <TaskLossCooldownStatus task={sample} />
    <CreateTaskRules value={rules} onChange={setRules} showAiOptions={false} showLifecycle={false} />
    <button id="validate" className="rounded border px-3 py-1" onClick={() => {
      try { setMessage(JSON.stringify(buildBottomPayload(rules))) }
      catch (error) { setMessage(String(error)) }
    }}>验证设置</button>
    <p id="result">{message}</p>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
