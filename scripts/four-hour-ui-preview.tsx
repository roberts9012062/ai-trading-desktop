/** Actual production forms against isolated fixtures; never submits an order. */
import { createRoot } from "react-dom/client"
import { useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { KlineChart } from "@/components/market/kline-chart"
import { CreateQuantDialog } from "@/components/ai-trading/form/create-quant-dialog"
import { CreateTaskDialog } from "@/components/ai-trading/form/create-task-dialog"
import { EditTaskDialog } from "@/components/ai-trading/form/edit-task-dialog"
import { FactorSearchForm } from "@/components/factor-lab/factor-search-form"
import { BacktestForm } from "@/components/backtest/backtest-form"
import { SyntheticPanel } from "@/components/backtest/synthetic-panel"
import { AnchorConfigForm } from "@/components/market/ai-anchor/anchor-config-form"
import { SuperFactorPage } from "@/components/super-factor/super-factor-page"
import ShortlineLabPageV2 from "@/components/shortline-lab/shortline-lab-page-v2"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { useAuthStore } from "@/stores/auth"
import type { AITradingTask } from "@/lib/ai-trading-api"
import type { User } from "@/types"
import "../src/app/globals.css"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限隔离验收5187")
localStorage.setItem("access_token", "fixture-only")
useAuthStore.setState({user:{id:"fixture",username:"验收",role:"admin",trading_mode:"virtual"} as User,accessToken:"fixture-only"})
useAppStore.setState({activeContract:"btcusdt"})
const model = {id:"fixture-model",display_name:"模拟模型",model_id:"test",provider_name:"mock",capabilities:["chat"]}
let requests = 0
let price = 100
const currentStart = Math.floor((Date.now()+28800000)/14400000)*14400000
const bars = () => Array.from({length:120},(_,i) => ({time:new Date(currentStart-(119-i)*14400000).toISOString().replace("T"," ").slice(0,19),open:100+Math.sin(i/3),high:104,low:97,close:i===119?price:100+Math.sin(i/3),volume:.25,market_source:"okx" as const,version:requests,kind:"correction"}))
globalThis.fetch = async (input,init) => {
  if (init?.method && init.method !== "GET") throw new Error("验收禁止写接口")
  const url = new URL(String(input),location.origin)
  if(url.pathname === "/api/market/kline/bundle") {requests++; return Response.json({symbol:"btcusdt",periods:["1m","5m","15m","30m","60m","240m"].map(period=>({period,bars:period==="240m"?bars():[],has_more:false}))})}
  if(url.pathname === "/api/market/kline") {requests++; return Response.json({symbol:"btcusdt",period:url.searchParams.get("period"),bars:bars(),has_more:false})}
  if(url.pathname === "/api/ai/models") return Response.json([model])
  if(url.pathname === "/api/ai-trading/funding-source") return Response.json({source:"site",balance_usdt:20000,site_balance_usdt:20000})
  if(url.pathname === "/api/market/session-status") return Response.json({is_open:true,sessions:[{start:"00:00",end:"24:00",cross_midnight:false}]})
  if(url.pathname.endsWith("/supported")) return Response.json({timeframes:[{value:"1d",label:"日线"},{value:"240m",label:"4小时"}],strategies:[]})
  if(url.pathname === "/api/market/contracts") return Response.json([])
  if(url.pathname === "/api/profit-lock-templates") return Response.json([])
  if(url.pathname === "/api/ai-anchor/indicators") return Response.json({indicators:{MA:[{key:"period",label:"周期",type:"int",default:20,min:1,max:100}],MACD:[]}})
  if(url.pathname.startsWith("/api/")) return Response.json({items:[],total:0})
  throw new Error("验收禁止真实下载")
}
const task = {id:"fixture-task",name:"4小时验收",symbol:"btcusdt",symbol_name:"BTC",timeframe:"240m",strategy_type:"swing_pivot",strategy_params:{},status:"stopped",model_row_id:"fixture-model",position_mode:"fixed_margin",side_mode:"both",margin_per_trade:100,allocated_capital:1000,close_rules:{},stop_rules:{},created_at:new Date().toISOString(),can_edit:true} as AITradingTask
function Preview() {
  const [open,setOpen]=useState(true)
  const [updates,setUpdates]=useState(0)
  const view=new URLSearchParams(location.search).get("view")
  return <main className="p-6 max-w-6xl mx-auto space-y-4">
    <p>4小时周期 · 隔离验收 · {updates}次模拟价格更新</p>
    {view==="quant"?<CreateQuantDialog open={open} onClose={()=>setOpen(false)}/>:
     view==="ai"?<CreateTaskDialog open={open} onClose={()=>setOpen(false)}/>:
     view==="edit"?<EditTaskDialog task={task} open={open} onClose={()=>setOpen(false)}/>:
     view==="factor"?<FactorSearchForm localEngine loading={false} defaultSymbol="btcusdt" onSearch={()=>{}} onSymbolChange={()=>{}}/>:
     view==="backtest"?<BacktestForm submitting={false} onSubmit={()=>{}}/>:
     view==="synthetic"?<SyntheticPanel busy={false} onGenerated={()=>{}}/>:
     view==="anchor"?<AnchorConfigForm/>:
     view==="shortline"?<ShortlineLabPageV2/>:
     view==="super"?<SuperFactorPage/>:
     <><button data-testid="realtime" onClick={()=>{price+=.25;useMarketStore.getState().updateKlineRealtime([{symbol:"btcusdt",period:"240m",bar:{...bars().at(-1)!,close:price,version:++requests}}]);setUpdates(v=>v+1)}}>更新4小时当前价</button><div style={{height:650}}><KlineChart userTradeLines="off"/></div></>}
  </main>
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><Preview/></MemoryRouter>)
