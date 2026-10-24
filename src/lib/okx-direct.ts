/** Official OKX public GETs only. No product JWT, account key or relay fallback. */
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { CollectionData, CollectionSymbol, CollectionBar, CollectionTick, CollectionQuote } from './collection-api'
const periods: Record<string,string> = { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'1H', '240':'4H', '1D':'1D' }
type Row = Record<string,unknown>
export async function directPublicGet(path:string):Promise<unknown[]> {
  if(!/^\/api\/v5\/(?:public\/(?:instruments|time)|market\/(?:candles|history-candles|ticker|tickers|trades|books))(?:\?[^#]*)?$/.test(path)||path.includes('\\'))throw new Error('不支持的 OKX 行情请求')
  let data:{code:string;msg?:string;data:unknown[]}
  if(isTauri()) data=await invoke('okx_public_http',{path})
  else {
    const response=await fetch('/__okx_direct__'+path,{signal:AbortSignal.timeout(15000),cache:'no-store',redirect:'error',credentials:'omit'})
    if(!response.ok)throw new Error(`OKX 直连 HTTP ${response.status}`)
    data=await response.json()
  }
  if(data.code!=='0'||!Array.isArray(data.data))throw new Error(`OKX 直连读取失败 (code=${data.code??'invalid'})：${data.msg||'返回数据异常'}`)
  return data.data
}
export async function directSymbols():Promise<CollectionSymbol[]> {
  const rows=await directPublicGet('/api/v5/public/instruments?instType=SWAP') as Row[]
  return rows.filter(r=>r.state==='live'&&r.settleCcy==='USDT'&&r.ctType==='linear'&&typeof r.instId==='string'&&/^[A-Z0-9]{1,16}-USDT-SWAP$/.test(r.instId)).map(r=>({symbol:String(r.instId),name:String(r.instId).split('-')[0]+' 永续',tick_size:String(r.tickSz),lot_size:String(r.lotSz),min_size:String(r.minSz),contract_value:String(r.ctVal),contract_value_currency:String(r.ctValCcy)}))
}
export async function directData(query:Record<string,unknown>):Promise<CollectionData> {
  const symbol=String(query.symbol??''),operation=String(query.operation??'')
  if(!/^[A-Z0-9]{1,16}-USDT-SWAP$/.test(symbol))throw new Error('不支持的 OKX 永续合约')
  const count=Number(query.count??100)
  if(!Number.isInteger(count)||count<1||count>5000)throw new Error('无效的 OKX 请求数量')
  let records:CollectionBar[]=[],ticks:CollectionTick[]=[],quotes:CollectionQuote[]=[]
  const params=new URLSearchParams({instId:symbol})
  if(operation==='history') {
    const bar=periods[String(query.resolution)]
    if(!bar)throw new Error('不支持的 K 线周期')
    params.set('bar',bar);params.set('limit',String(Math.min(300,count)))
    if(query.end!==undefined){const end=Number(query.end);if(!Number.isFinite(end))throw new Error('无效历史游标');params.set('after',String((end+1)*1000))}
    const rows=await directPublicGet(`/api/v5/market/${query.end===undefined?'candles':'history-candles'}?${params}`) as unknown[][]
    records=rows.map(r=>({timestamp:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),contract_volume:Number(r[5]),volume:Number(r[6]),quote_volume:Number(r[7]),closed:r[8]==='1'}))
  } else if(operation==='ticks') {
    params.set('limit',String(Math.min(500,count)))
    const rows=await directPublicGet('/api/v5/market/trades?'+params) as Row[]
    ticks=rows.map(r=>({timestamp:Number(r.ts)/1000,price:Number(r.px),volume:Number(r.sz),side:String(r.side),trade_id:String(r.tradeId),volume_unit:'contracts'}))
  } else if(operation==='quotes') {
    const rows=await directPublicGet('/api/v5/market/ticker?'+params) as Row[]
    quotes=rows.map(r=>({price:Number(r.last),timestamp:Number(r.ts)/1000,bid:Number(r.bidPx),ask:Number(r.askPx),reference_price:Number(r.open24h),change_percent:Number(r.open24h)>0?(Number(r.last)/Number(r.open24h)-1)*100:0,high_24h:Number(r.high24h),low_24h:Number(r.low24h),base_volume_24h:Number(r.volCcy24h),bid_size:Number(r.bidSz),ask_size:Number(r.askSz),size_unit:'contracts'}))
  } else throw new Error('不支持的 OKX 数据类型')
  return {symbol,records,ticks,quotes,meta:{returned_count:records.length+ticks.length+quotes.length,history_complete:false}}
}
