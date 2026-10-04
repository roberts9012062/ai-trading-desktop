/** Actual components, isolated fake API: never creates a task or order. */
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import '../src/app/globals.css'
import {CreateTaskDialog} from '@/components/ai-trading/form/create-task-dialog'
import {TaskList} from '@/components/ai-trading/task-list'
import {KlineChart} from '@/components/market/kline/kline-chart'
import {useAuthStore} from '@/stores/auth'
import {useAITradingStore} from '@/stores/ai-trading'
import {useMarketStore} from '@/stores/market'
import {useAppStore} from '@/stores/app'
import {useAiMarketStore} from '@/stores/ai-market'
import AiMarketPage from '@/app/(main)/ai-market/page'
import {DEFAULT_FORECAST} from '@/lib/ai-forecast'
import type {AITradingTask} from '@/lib/ai-trading-api'
import type {User} from '@/types'

if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw new Error('只允许隔离验收端口5187')
useAuthStore.setState({user:{id:'fixture',username:'验收',role:'admin',trading_mode:'virtual'} as User,accessToken:'fixture-only'})
localStorage.setItem('access_token','fixture-only')
useAppStore.setState({activeContract:'btcusdt'})
let task={id:'forecast-fixture',name:'BTC预测验收',symbol:'btcusdt',symbol_name:'BTC',timeframe:'5m',extra_timeframes:[],
 model_row_id:'fixture-model',strategy_type:'ai',strategy_params:{mode:'forecast',forecast:DEFAULT_FORECAST,forecast_state:{stage:'pending',plan:{direction:'long',entry:100,take_profit:109,stop_loss:97}}},
 status:'running',position_mode:'fixed_margin',side_mode:'both',allocated_capital:1000,margin_per_trade:100,margin_mode:'isolated',leverage:5,ai_bars_limit:60,
 close_rules:{},stop_rules:{},created_at:new Date().toISOString(),position_qty:0,risk_style:'balanced',can_edit:false} as AITradingTask
const counts={kline:0,task:0};Object.assign(window,{forecastCounts:counts})
const times=Array.from({length:60},(_,i)=>Math.floor(Date.now()/300000)*300000-(59-i)*300000)
const bars=()=>times.map((time,i)=>({time:new Date(time+28800000).toISOString().replace('T',' ').slice(0,19),open:100+Math.sin(i/3),close:100+Math.sin((i+1)/3)+(i===59?counts.kline*.03:0),high:102,low:98,volume:100+i}))
useMarketStore.setState({initWebSocket:()=>{},klineBars:{btcusdt:{'5m':bars(),'15m':bars(),'1d':bars().map((b,i)=>({...b,time:new Date(Date.now()-(59-i)*86400000).toISOString().slice(0,10)}))}},quotes:{}})
globalThis.fetch=async(input,init)=>{
 const path=new URL(String(input),'http://127.0.0.1:5187').pathname
 if(init?.method&&init.method!=='GET')throw new Error('验收禁止写接口')
 if(path==='/api/ai/models')return Response.json([{id:'fixture-model',display_name:'AI模型验收',model_id:'test',provider_name:'mock',capabilities:['chat']}])
 if(path==='/api/ai-trading/funding-source')return Response.json({source:'site',balance_usdt:20000,site_balance_usdt:20000})
 if(path==='/api/ai-anchor/indicators')return Response.json({indicators:{MA:[{key:'period',label:'周期',type:'int',default:20,min:1,max:100}],MACD:[]}})
 if(path==='/api/profit-lock-templates')return Response.json([])
 if(path==='/api/ai-trading/tasks/forecast-fixture/forecast-kline'){counts.kline++;return Response.json({bars:bars(),source:'okx'})}
 if(path==='/api/ai-trading/tasks/forecast-fixture'){counts.task++;return Response.json(task)}
 if(path==='/api/market/session-status')return Response.json({is_open:true})
 if(path.startsWith('/api/news'))return Response.json([])
 if(path.endsWith('/run-logs'))return Response.json({items:[],total:0})
 throw new Error('验收未授权API '+path)
}
function Preview(){
 const [current,setCurrent]=useState(task),[open,setOpen]=useState(false),[output,setOutput]=useState('')
 useAITradingStore.setState({createTask:async payload=>{setOutput(JSON.stringify(payload));return {...payload,id:'only-fixture'} as AITradingTask}})
 return <main className="p-4 space-y-4 max-w-6xl mx-auto">
  <h1>AI预测交易 · 隔离模拟数据</h1>
  <div className="flex gap-4 text-sm"><button onClick={()=>setOpen(true)}>创建界面验收</button><button data-fixture-fill onClick={()=>{task={...task,position_qty:5,position_direction:'long',position_avg_price:100.15,position_unrealized:12.34,strategy_params:{...task.strategy_params,forecast_state:{stage:'holding',filled_qty:5,position_price:100.15,plan:{direction:'long',entry:100,take_profit:109,stop_loss:101}}}};setCurrent(task)}}>模拟成交和收紧止损</button><button data-fixture-close onClick={()=>{task={...task,status:'stopped',position_qty:0,strategy_params:{...task.strategy_params,forecast_state:{stage:'completed'}}};setCurrent(task)}}>模拟平仓结束</button></div>
  <TaskList tasks={[current]} selectedId={null} onSelect={()=>{}}/>
  <div className="h-[420px]"><KlineChart forecastTasks={[current]} userTradeLines="off"/></div>
  <CreateTaskDialog open={open} onClose={()=>setOpen(false)} prefillFrom={{...task,strategy_params:{},status:'stopped'} as AITradingTask}/>
  <pre id="forecast-submitted" className="text-xs whitespace-pre-wrap break-all">{output}</pre>
 </main>
}
const marketPreview=new URLSearchParams(location.search).has('ai-market')
if(marketPreview)useAiMarketStore.setState({tasks:[task],tasksLoaded:true,selectedTaskId:task.id,loadTasks:async()=>{useAiMarketStore.setState({tasks:[{...task}]})},loadRecords:async()=>{},refreshMarks:async()=>{}})
createRoot(document.getElementById('root')!).render(<MemoryRouter>{marketPreview?<div className="h-screen"><AiMarketPage/></div>:<Preview/>}</MemoryRouter>)
