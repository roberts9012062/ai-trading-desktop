import {createRoot} from "react-dom/client"
import {useState} from "react"
import {DataChannelSelect} from "@/components/common/data-channel-select"
import {FactorSearchForm} from "@/components/factor-lab/factor-search-form"
import {BacktestForm} from "@/components/backtest/backtest-form"
import {SuperFactorPage} from "@/components/super-factor/super-factor-page"
import ShortlineLabPageV2 from "@/components/shortline-lab/shortline-lab-page-v2"
import "../src/app/globals.css"
if(location.hostname!=="127.0.0.1"||location.port!=="5187")throw new Error("仅限隔离验收5187")
// These real forms run against empty fixtures; clicking does not call an account or an exchange.
globalThis.fetch=async input=>{
  const path=String(input)
  if(path.includes("/api/market/contracts"))return Response.json([])
  if(path.includes("/supported"))return Response.json({timeframes:[],strategies:[]})
  if(path.includes("/api/"))return Response.json({items:[],total:0})
  throw new Error("验收禁止真实下载")
}
function Preview(){
  const [channel,setChannel]=useState("okx")
  const [range,setRange]=useState("")
  const view=new URLSearchParams(location.search).get("view")
  return <main className="max-w-5xl mx-auto p-6 space-y-4">
    <p>历史研究渠道 · 隔离验收</p>
    {view==="backtest"?<BacktestForm submitting={false} onSubmit={()=>{}}/>:
     view==="factor"?<FactorSearchForm localEngine loading={false} defaultSymbol="btcusdt" onSearch={()=>{}} onSymbolChange={()=>{}}/>:
     view==="shortline"?<ShortlineLabPageV2/>:
     view==="super"?<SuperFactorPage/>:
     <><DataChannelSelect value={channel} onChange={setChannel} symbol="btcusdt" timeframe="15m" kinds={["swap"]} onRange={r=>setRange(r?`${r.channel}:${r.min_date}:${r.max_date}`:"")}/><output data-testid="channel-range">{range}</output><button onClick={()=>setChannel(c=>c)}>模拟重渲染</button></>}
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview/> )
