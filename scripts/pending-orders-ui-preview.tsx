import { createRoot } from 'react-dom/client'
import '../src/app/globals.css'
import OrdersPage from '@/app/(main)/orders/page'
if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw new Error('只允许本地隔离验收')
const failed=new URLSearchParams(location.search).has('failure')
const regular={order_id:'ordinary',symbol:'btcusdt',side:'buy',offset:'open',order_type:'limit',price:100,quantity:1,status:'live',created_at:new Date().toISOString()}
const algo=(id:string,values:object)=>({order_id:id,algo_id:id,order_kind:'algo',symbol:'ethusdt',side:'buy',offset:'close',quantity:0,status:'live',margin_mode:'cross',can_cancel:false,can_amend:false,created_at:new Date().toISOString(),...values})
globalThis.fetch=async(input,init)=>{
 const url=String(input)
 if(init?.method && init.method!=='GET')throw new Error('验收禁止写入交易接口')
 if(url.includes('/api/live/orders')){
  if(url.includes('history=true'))return Response.json({orders:[{...regular,id:'mirror',exchange_order_id:'missing',order_id:undefined,status:'pending'}]})
  if(failed)return Response.json({detail:'OKX 条件单查询超时'},{status:502})
  return Response.json({orders:[regular,algo('protect',{order_type:'oco',quantity:.37,tp_price:2689.5,sl_price:2700.8}),
   algo('stop',{order_type:'conditional',close_fraction:1,sl_price:2700.8}),
   algo('entry',{order_type:'trigger',offset:'open',quantity:.5,trigger_price:2710,tp_price:2750,sl_price:2690})]})
 }
 if(url.includes('/api/live/positions'))return Response.json({positions:[]})
 if(url.includes('/api/live/account'))return Response.json({balance:1000,available:900,equity:1000})
 return Response.json({})
}
createRoot(document.getElementById('root')!).render(<div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-screen"><OrdersPage/></div>)
