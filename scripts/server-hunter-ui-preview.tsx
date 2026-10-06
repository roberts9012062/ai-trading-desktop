/** Isolated UI verification. All account, market and trading APIs are mocked. */
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/app/globals.css"
import { CreateHunterDialog } from "@/components/hunter/create-hunter-dialog"
import { HunterPanel } from "@/components/hunter/hunter-panel"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"
import { useHunterStore } from "@/stores/hunter"
import { useAuthStore } from "@/stores/auth"
import type { User } from "@/types"

const params = new URLSearchParams(location.search), vip = params.get("vip") !== "0", panel = params.has("panel")
window.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
hunterApi.capabilities = async () => ({ can_start: true, live_qualified: false, trading_mode: "live", execution_mode: "okx_demo", reason: "",
  server_hosting_available: true, can_server_host: vip, supported_versions: ["hunter-v1","hunter-v2","hunter-v3","hunter-v4","hunter-macd-ma20"] })
hunterApi.symbols = async () => [{ symbol: "btcusdt", name: "BTC / USDT" }]
useAuthStore.setState({ user: { id:"isolated-preview", username:"isolated-preview", trading_mode:"live", role:vip ? "admin" : "user" } as User })
let group = { id:"isolated-group", name:"AI 多周期猎手 · 托管验收", status:"running", trading_mode:"live", capital:1000, equity:1000, blocks:[],
  config:{ name:"AI 多周期猎手", scan_location:"desktop", strategy_version:"hunter-macd-ma20", venue:"okx", leverage:10,margin_mode:"cross",brain:"rules",cycles:["30m","60m"],max_positions:4 },
  runtime:{execution_account:{execution_mode:"okx_demo"}},stats:{trades:0,win_rate:null,profit_factor:null,payoff:null},opportunities:[] } as unknown as Hunter
hunterApi.list = async () => panel ? [group] : []
hunterApi.hosting = async (_id,scan_location) => {
  if (scan_location === "server" && !vip) throw new Error("服务器托管为VIP专属")
  group={...group,config:{...group.config,scan_location},runtime:{...group.runtime,hosting:{cycles:{"30m":{at:Date.now()/1000,phase:"waiting",note:"本轮无合格新信号",counts:{signals:0,mounted:0}},"60m":{phase:"scanning",note:"服务器扫描中",counts:{}}}}}}
  return group
}
function Preview() {
  const [open,setOpen] = useState(!panel), [payload,setPayload] = useState<HunterConfig | null>(null)
  useEffect(()=>{useHunterStore.setState({create:async config=>{setPayload(config)}})},[])
  return <main className="p-6"><p>隔离界面验收：不会提交真实订单</p>
    {panel ? <HunterPanel /> : <CreateHunterDialog open={open} onClose={()=>setOpen(false)} />}
    <pre id="result">{payload ? JSON.stringify(payload,null,2) : "等待操作"}</pre>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)
