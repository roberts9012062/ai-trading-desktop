import { createRoot } from 'react-dom/client'
import '../src/app/globals.css'
import { MetricsPanel } from '@/components/dashboard/metrics-panel'
import { usePaperTradingStore } from '@/stores/paper-trading'
if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw new Error('只允许本地隔离验收')
const kind=new URLSearchParams(location.search).get('kind')||'net'
usePaperTradingStore.setState({mode:'live',loaded:true,positions:[],orders:[],account:null})
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin)
 if(url.pathname!=='/api/live/daily-pnl'||(init?.method&&init.method!=='GET'))throw new Error('验收禁止访问其他接口')
 if(kind==='error')return Response.json({detail:'测试查询失败'},{status:502})
 const date=new Date(Date.now()+28800000).toISOString().slice(0,10)
 return Response.json({days:[{date,pnl:10,net:10,fee:3,fee_cost:3,funding:-1.25,...(kind==='net'?{net_after_costs:5.75}:{}),win_pnl:12,loss_pnl:-2,trades:3,cumulative:10}],summary:{net:10}})
}
createRoot(document.getElementById('root')!).render(<main className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-8"><h1 className="text-xl mb-4">数据看板 · 扣费净利润验收</h1><p className="text-sm text-[var(--text-muted)] mb-6">毛盈亏 10 − 当日手续费 3 − 已结算资金费 1.25 = 净利润 5.75 USDT</p><MetricsPanel/></main>)
