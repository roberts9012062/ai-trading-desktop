import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import '../src/app/globals.css'
import { TaskList } from '@/components/ai-trading/task-list'
import type { AITradingTask } from '@/lib/ai-trading-api'
if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw new Error('只允许本地隔离验收')
globalThis.fetch=async(_input,init)=>{
 if(init?.method && init.method!=='GET')throw new Error('验收禁止调用交易写接口')
 return Response.json({is_open:true,status:'open',session_name:'24h',source:'okx'})
}
const base={id:'forecast-preview',name:'ETH 连续预测',symbol:'ethusdt',symbol_name:'ETH',strategy_type:'ai',
 status:'running',trading_mode:'live',timeframe:'15m',leverage:5,margin_mode:'cross',max_hold_days:10,hold_days_left:6,
 started_at:'2026-10-01T04:00:00Z',position_opened_at:null,position_qty:0,position_unrealized:0,realized_pnl:5,
 position_mode:'fixed_margin',margin_per_trade:100,close_rules:{},stop_rules:{},has_open_position:false,
 model_display_name:'预测模型',runtime_seconds:1000,has_orders:true,
 strategy_params:{mode:'forecast',forecast_state:{stage:'watching',completed_cycles:2,trading_started_at:'2026-10-01T04:00:00Z'}}} as unknown as AITradingTask
function Preview(){
 const [holding,setHolding]=useState(false)
 const task=holding ? {...base,position_qty:.37,position_opened_at:'2026-10-05T00:00:00Z',position_direction:'short',
  position_avg_price:2697,position_unrealized:3,has_open_position:true,strategy_params:{mode:'forecast',forecast_state:{
   stage:'holding',completed_cycles:2,trading_started_at:'2026-10-01T04:00:00Z',filled_qty:.37,
   plan:{direction:'short',entry:2697,take_profit:2689,stop_loss:2700}}}} as AITradingTask : base
 return <main className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-screen p-6 max-w-3xl">
  <h1>预测任务 · 周期内连续循环</h1>
  <p className="text-sm my-3">本轮平仓后重新预测，剩余天数按任务启动时间计算。</p>
  <button className="mb-4 rounded border p-2" onClick={()=>setHolding(!holding)}>{holding?'模拟本轮平仓':'模拟下一轮持仓'}</button>
  <TaskList tasks={[task]} selectedId={null} onSelect={()=>{}}/>
 </main>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
