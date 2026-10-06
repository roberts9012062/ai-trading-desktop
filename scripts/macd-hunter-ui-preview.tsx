/** Isolated fixture: mocked account/capabilities, no network or real trading. */
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateHunterDialog } from "@/components/hunter/create-hunter-dialog"
import { hunterApi, type HunterConfig } from "@/lib/hunter/api"
import { useHunterStore } from "@/stores/hunter"
import { useAuthStore } from "@/stores/auth"
import type { User } from "@/types"

window.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
hunterApi.capabilities = async () => ({ can_start: true, live_qualified: false, trading_mode: "live", execution_mode: "okx_demo", reason: "",
  supported_versions: ["hunter-v1", "hunter-v2", "hunter-v3", "hunter-v4", "hunter-macd-ma20"] })
hunterApi.symbols = async () => [{ symbol: "btcusdt", name: "BTC / USDT" }]
useAuthStore.setState({ user: { id: "preview", username: "preview", trading_mode: "live", role: "admin" } as User })

function Preview() {
  const [open,setOpen] = useState(true)
  const [payload,setPayload] = useState<HunterConfig | null>(null)
  useEffect(() => { useHunterStore.setState({ create: async config => { setPayload(config) } }) }, [])
  return <main className="p-6"><button onClick={()=>setOpen(true)}>打开验收窗口</button>
    <CreateHunterDialog open={open} onClose={()=>setOpen(false)} />
    <pre id="result">{payload ? JSON.stringify(payload,null,2) : "隔离验收：不会创建真实任务"}</pre>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
