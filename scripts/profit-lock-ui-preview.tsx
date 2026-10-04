/** Isolated shared-form fixture; never contacts a server or creates an order. */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateTaskRules, EMPTY_RULE_FORM, buildCloseRulesPayload, buildBottomPayload, rulesFromTask } from "@/components/ai-trading/form/create-task-rules"
import { Button } from "@/components/ui/button"
if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("只能在隔离验收端口5187运行")
globalThis.fetch = async () => { throw new Error("锁利界面验收禁止真实API请求") }
function Preview() {
  const [rules,setRules] = useState(EMPTY_RULE_FORM)
  const [ai,setAi] = useState(true)
  const [output,setOutput] = useState("")
  const [error,setError] = useState("")
  return <main className="mx-auto max-w-lg p-4 space-y-4">
    <h1 className="text-lg">锁利润 · 隔离验收</h1>
    <label className="flex gap-2"><input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} />AI类型（取消即量化类型）</label>
    <CreateTaskRules value={rules} onChange={setRules} showAiOptions={ai} showLifecycle={false} />
    <p role="alert">{error}</p>
    <Button onClick={() => { try { buildBottomPayload(rules); const close_rules = buildCloseRulesPayload(rules,ai); setOutput(JSON.stringify(close_rules,null,2)); setRules(rulesFromTask({close_rules,max_profit_pct:20,max_loss_pct:10})); setError("") } catch (e) { setError(String((e as Error).message)) } }}>保存并模拟编辑回填</Button>
    <pre id="submitted" className="text-xs whitespace-pre-wrap">{output}</pre>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
