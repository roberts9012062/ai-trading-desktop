import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/app/globals.css'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/ui/numeric-input'
import { Button } from '@/components/ui/button'
import { NumberField } from '@/components/market/indicator-form-fields'
import { MarginLeverageFields, type MarginLeverageValue } from '@/components/ai-trading/form/margin-leverage-fields'
import { FactorSearchForm } from '@/components/factor-lab/factor-search-form'
if(location.hostname!=='127.0.0.1'||location.port!=='5187')throw new Error('只允许本地隔离验收')
globalThis.fetch=async(input)=>{
 const url=String(input)
 if(url.includes('/api/history/channels'))return Response.json({channels:[]})
 if(url.includes('/api/history/range'))return Response.json({detail:'验收不读取真实历史数据'},{status:502})
 return Response.json(/contracts|models/.test(url)?[]:{demo:true,mode:'live',exchange:'okx',source:'api'})
}
function FactorPreview(){
 const [result,setResult]=useState('')
 return <main className="p-8 bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-screen"><h1>因子搜索 · 真实表单编辑验收</h1><FactorSearchForm defaultSymbol="btcusdt" loading={false} onSymbolChange={()=>{}} onSearch={payload=>setResult(JSON.stringify(payload))}/><output data-testid="factor-result">{result}</output></main>
}
function Preview(){
 const [margin,setMargin]=useState<MarginLeverageValue>({marginPerTrade:100,leverage:5,marginMode:'isolated'})
 const [period,setPeriod]=useState(15),[optional,setOptional]=useState(''),[signed,setSigned]=useState(-.5)
 const [saved,setSaved]=useState(''),[cancelled,setCancelled]=useState(0),[count,setCount]=useState(0)
 const [native,setNative]=useState(30),[formSaved,setFormSaved]=useState('')
 return <main className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-8 space-y-5 max-w-2xl">
  <h1 className="text-xl">数字输入 · 可清空重写，完成后校验</h1>
  <section data-numeric-scope className="border border-[var(--border)] rounded p-4 space-y-4">
   <MarginLeverageFields value={margin} onChange={setMargin} lastPrice={10}/>
   <NumberField label="指标周期" value={period} min={2} max={100} onChange={setPeriod}/>
   <label>可选止盈<Input aria-label="可选止盈" type="number" min={0} step="any" value={optional} onChange={e=>setOptional(e.target.value)}/></label>
   <label>有符号小数<NumericInput aria-label="有符号小数" value={signed} step="any" onChange={e=>setSigned(Number(e.target.value))} className="border rounded p-2"/></label>
   <div className="flex gap-2"><Button validateNumbers onClick={()=>{setCount(n=>n+1);setSaved(JSON.stringify({margin:margin.marginPerTrade,period,optional,signed}))}}>保存参数</Button><Button variant="outline" onClick={()=>setCancelled(n=>n+1)}>取消</Button><Button resetNumbers variant="outline" onClick={()=>{setMargin({...margin,marginPerTrade:100});setPeriod(15);setSigned(-.5);setOptional('')}}>恢复默认</Button></div>
   <output data-testid="saved">{saved}</output><output data-testid="count">{count}</output><output data-testid="cancelled">{cancelled}</output>
  </section>
  <form className="space-y-2" onSubmit={e=>{e.preventDefault();setFormSaved(String(native))}}>
   <label>原生表单<Input aria-label="原生表单" type="number" min={1} max={50} step={1} value={native} onChange={e=>setNative(Number(e.target.value))}/></label><Button type="submit">提交表单</Button><output data-testid="form-saved">{formSaved}</output>
  </form>
  <aside>输入过程中不补默认值、不跳到最低值；取消不受数字校验阻拦。</aside>
 </main>
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('kind')==='factor'?<FactorPreview/>:<Preview/> )
