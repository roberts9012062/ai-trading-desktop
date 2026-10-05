import {createRoot} from "react-dom/client"
import "../src/app/globals.css"
import {BacktestForm} from "@/components/backtest/backtest-form"
import {FactorSearchForm} from "@/components/factor-lab/factor-search-form"
import {SuperFactorPage} from "@/components/super-factor/super-factor-page"
import ShortlineLabPageV2 from "@/components/shortline-lab/shortline-lab-page-v2"
if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("只允许本机隔离验收")
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith("/api/factor-mining/supported")) return new Response(JSON.stringify({timeframes:[{value:"1d",label:"日线",long_history:true,note:""}],device_options:[],max_running_per_user:1}))
  if (url.includes("/ai-models")) return new Response("[]")
  if (url.includes("/contracts")) return new Response("[]")
  throw new Error("隔离页面禁止交易与真实网络")
}
const mode = new URLSearchParams(location.search).get("mode")
const view = mode === "factor" ? <FactorSearchForm defaultSymbol="btcusdt" localEngine loading={false} onSearch={() => {throw new Error("禁止启动任务")}} onSymbolChange={() => {}}/>
  : mode === "super" ? <SuperFactorPage/> : mode === "short" ? <ShortlineLabPageV2/>
  : <BacktestForm submitting={false} onSubmit={() => {throw new Error("禁止启动回测")}}/>
createRoot(document.getElementById("root")!).render(<div className="p-6 max-w-5xl mx-auto">{view}</div>)
