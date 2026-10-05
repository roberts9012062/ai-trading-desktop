import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import '../src/app/globals.css'
import ShortlineExecutionPanel from '@/components/shortline-lab/shortline-execution-panel'
import {DEFAULT_EXECUTION_SETTINGS, type ExecutionReview} from '@/lib/shortline/execution-review'
import {saveDayDigest} from '@/lib/shortline/backfill/pipeline'
if(location.hostname!=='127.0.0.1'||location.port!=='5187') throw new Error('只允许本地隔离验收')
globalThis.fetch=async(input,init)=>{
 const url=String(input)
 if(url.includes('/fee-rates'))return Response.json({rates:[{symbol:'previewusdt',maker:-.02,taker:-.05}]})
 if(url.includes('/execution-review')) {
  const body=JSON.parse(String(init?.body))
  if(body.payload.eval_version!=='shortline-eval-v2'||body.steps.length<10)throw new Error('回放载荷不完整')
  const m={closed_trades:120,wins:48,losses:72,win_rate:.4,net_profit:60,expectancy:.5,payoff_ratio:3,
    profit_factor:2,max_drawdown:12,fees:20,funding:0,average_win:3,average_loss:1,gaps:0,missing_scores:0}
  return Response.json({version:'shortline-execution-review-v2',source:'binance_usdt',qualified:false,research_passed:false,
    review_sha:'a'.repeat(64),configuration:body,reasons:['venue_mismatch'],limitations:['modelled_market_fills'],
    base:{metrics:m,trades:[],equity:[]},stress:{metrics:{...m,net_profit:30},trades:[],equity:[]},periods:[m,m]})
 }
 throw new Error('隔离验收禁止任何交易接口：'+url)
}
async function prepare(){
 for(let day=0;day<12;day++){
  const start=Date.UTC(2026,8,1+day)/1000
  const buckets=Array.from({length:1440},(_,i)=>{
   const close=100+Math.sin((day*1440+i)*.04)*5
   return {ts:start+i*60,open:close,high:close+.1,low:close-.1,close,vol:10,quote:close*10,takerBuyVol:5,takerBuyQuote:close*5,count:5}
  })
  await saveDayDigest('PREVIEWUSDT',new Date(start*1000).toISOString().slice(0,10),buckets)
 }
}
function Preview(){
 const [settings,setSettings]=useState(DEFAULT_EXECUTION_SETTINGS)
 const [fee,setFee]=useState(.0005)
 const [ready,setReady]=useState(false)
 const [report,setReport]=useState<ExecutionReview|null>(null)
 return <main className="min-h-screen bg-[#0F131C] text-white p-6 space-y-4">
  <h1>短线执行复核 · 本地隔离验收（合成行情/模拟结果）</h1>
  <button className="border rounded p-2" onClick={()=>void prepare().then(()=>setReady(true))}>{ready?'测试归档已准备':'准备测试归档'}</button>
  <ShortlineExecutionPanel taskId="preview" symbol="PREVIEWUSDT" timeframe="15m" cadence={15} champions={[{id:1,tokens:[4,102]}]}
   settings={settings} onSettings={setSettings} feeRate={fee} onFeeRate={setFee} disabled={false} onReport={setReport}/>
  <p>验收报告状态：{report?'已返回':'未返回'}</p>
 </main>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
