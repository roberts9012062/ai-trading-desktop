import type { KlineBar, TradeRecord, CodeTreeMap } from '@/types'
import type { QuoteData } from './websocket'
import { COLLECTION_BASE, collectionRequest, collectionGeneration } from './collection-config'

export const COLLECTION_PERIODS:Record<string,string>={'1m':'1','5m':'5','15m':'15','30m':'30','60m':'60','240m':'240','1d':'1D'}
export interface CollectionSymbol {symbol:string;name:string;tick_size?:string|null;lot_size?:string|null;min_size?:string|null;contract_value?:string|null;contract_value_currency?:string|null}
export interface CollectionBar {timestamp:number;open:number;high:number;low:number;close:number;volume:number|null;contract_volume?:number|null;quote_volume?:number|null;closed?:boolean|null}
export interface CollectionTick {timestamp:number|null;price:number;volume:number|null;side?:string|null;trade_id?:string|null;volume_unit?:string}
export interface CollectionQuote {price?:number;lp?:number;timestamp?:number;bid?:number|null;ask?:number|null;reference_price?:number|null;change_percent?:number|null;high_24h?:number|null;low_24h?:number|null;base_volume_24h?:number|null;bid_size?:number|null;ask_size?:number|null;size_unit?:string}
export interface CollectionData {symbol:string;records:CollectionBar[];ticks:CollectionTick[];quotes:CollectionQuote[];meta:{returned_count:number;history_complete:boolean}}
export function collectionSymbol(symbol:string):string {const s=symbol.trim().toLowerCase();if(!/^[a-z0-9]{1,16}usdt$/.test(s))throw new Error('不支持的加密货币合约');return s.slice(0,-4).toUpperCase()+'-USDT-SWAP'}
export function desktopSymbol(symbol:string):string {if(!/^[A-Z0-9]{1,16}-USDT-SWAP$/.test(symbol))throw new Error('无效的永续合约');return symbol.replace('-USDT-SWAP','usdt').toLowerCase()}
export function ticketAddress(raw:string,ws=true):string {
  const url=new URL(raw,COLLECTION_BASE)
  if(url.origin!==COLLECTION_BASE||url.username||url.password||url.hash||!['/edge/ws','/edge/data'].includes(url.pathname)||[...url.searchParams.keys()].some(k=>k!=='ticket')||!url.searchParams.get('ticket'))throw new Error('无效的行情票据地址')
  if(ws)url.protocol='wss:'
  return url.href
}
export function beijingTime(seconds:number,daily=false):string {return new Date(seconds*1000+28800000).toISOString().replace('T',' ').slice(0,daily?10:19)}
export function mapCollectionBar(row:CollectionBar,period:string):KlineBar & {market_source:'okx';settle:null;open_interest:null} {
  if(![row.timestamp,row.open,row.high,row.low,row.close].every(Number.isFinite)||Math.min(row.open,row.high,row.low,row.close)<=0||row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high)||row.volume===null||!Number.isFinite(row.volume)||row.volume<0)throw new Error('K线字段不完整')
  return {time:beijingTime(row.timestamp,period==='1d'),open_time:row.timestamp*1000,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume,quote_volume:row.quote_volume,market_source:'okx',is_closed:row.closed,version:Date.now(),kind:'correction',settle:null,open_interest:null}
}
export function mapCollectionTrade(row:CollectionTick):TradeRecord {
  if(!row.trade_id||!['buy','sell'].includes(row.side||'')||row.timestamp===null||!Number.isFinite(row.timestamp)||!Number.isFinite(row.price)||row.price<=0||row.volume===null||!Number.isFinite(row.volume)||row.volume<0)throw new Error('成交字段不完整')
  return {trade_id:row.trade_id,time:beijingTime(row.timestamp).slice(11),ts:String(row.timestamp*1000),price:row.price,volume:row.volume,direction:row.side as 'buy'|'sell',source:'realtime',volume_unit:row.volume_unit||'unknown'}
}
export function mapCollectionQuote(symbol:string,row:CollectionQuote):QuoteData {
  const price=row.price??row.lp
  if(!price||!Number.isFinite(price)||!row.timestamp||!Number.isFinite(row.timestamp))throw new Error('报价字段不完整')
  return {symbol,name:symbol.toUpperCase(),exchange:'OKX',last_price:price,change:row.reference_price?price-row.reference_price:0,change_pct:row.change_percent??0,pre_close:row.reference_price??0,open_price:row.reference_price??0,high_price:row.high_24h??0,low_price:row.low_24h??0,bid_price:row.bid??0,ask_price:row.ask??0,bid_vol:row.bid_size??0,ask_vol:row.ask_size??0,volume:row.base_volume_24h??0,position:0,tick_time:beijingTime(row.timestamp),recv_ts:row.timestamp*1000,decimal_places:String(price).split('.')[1]?.length??0,source:'lium-okx'}
}
let ticketQueue:Promise<unknown>=Promise.resolve(),nextTicketAt=0
export async function collectionTicket(query:Record<string,unknown>){
  const generation=collectionGeneration()
  const request=ticketQueue.catch(()=>{}).then(async()=>{
    const delay=Math.max(0,nextTicketAt-Date.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay))
    if(generation!==collectionGeneration())throw new Error('行情配置已变化')
    nextTicketAt=Date.now()+750
    return collectionRequest<{url:string;expires_in:number}>('/api/tickets',query)
  })
  ticketQueue=request;return request
}
let dataQueue:Promise<unknown>=Promise.resolve()
export function collectionHttpSlot<T>(work:()=>Promise<T>):Promise<T>{
  const request=dataQueue.catch(()=>{}).then(work)
  dataQueue=request
  return request
}
export async function collectionData(query:Record<string,unknown>):Promise<CollectionData>{
  const generation=collectionGeneration()
  return collectionHttpSlot(async()=>{
    if(generation!==collectionGeneration())throw new Error('行情配置已变化')
    for(let attempt=0;;attempt++){
      try {const ticket=await collectionTicket(query),url=new URL(ticketAddress(ticket.url,false));return await collectionRequest<CollectionData>(url.pathname+url.search)}
      catch(error){
        const message=error instanceof Error?error.message:String(error)
        if(attempt>=2||!/rate_limited|connection_limit|ticket_used_or_expired|request_in_progress/.test(message))throw error
        await new Promise(resolve=>setTimeout(resolve,attempt===0?2000:5000))
        if(generation!==collectionGeneration())throw new Error('行情配置已变化')
      }
    }
  })
}
let catalog:CollectionSymbol[]=[],catalogVersion=-1,flight:Promise<CollectionSymbol[]>|null=null
export async function collectionSymbols(text=''):Promise<CollectionSymbol[]>{
  const version=collectionGeneration()
  if(!text&&catalogVersion===version&&catalog.length)return catalog
  if(!text&&flight)return flight
  const load=async()=>{
    let offset=0;const rows:CollectionSymbol[]=[]
    for(let page=0;page<10;page++){
      const query=new URLSearchParams({market_type:'crypto',exchange:'okx',text,limit:'1000',offset:String(offset)})
      const result=await collectionRequest<CollectionSymbol[]>('/v1/symbols?'+query)
      rows.push(...result);if(result.length<1000)break;offset+=1000
    }
    const unique=[...new Map(rows.map(row=>[row.symbol,row])).values()]
    if(!text&&version===collectionGeneration()){catalog=unique;catalogVersion=version}
    return unique
  }
  if(text)return load()
  flight=load().finally(()=>{flight=null});return flight
}
export function collectionSpec(symbol:string){return catalog.find(row=>row.symbol===collectionSymbol(symbol))}
// Keep a stable, bounded desktop universe; catalog metadata remains available to
// existing tasks without subscribing every exchange listing to the sidebar feed.
const DESKTOP_PRIORITY = 'BTC ETH SOL XRP DOGE BNB ADA LINK AVAX LTC TRX DOT BCH TON UNI AAVE SUI NEAR APT INJ SEI ICP ATOM ETC FIL ALGO VET IMX ARB OP LDO CRV COMP SNX GRT TIA SAND MANA AXS GALA CHZ PEPE WIF BONK FLOKI ORDI WLD ENA FET RENDER JUP PYTH STX HBAR XLM XMR ZEC DASH DYDX ENS'.split(' ')
export function selectDesktopSymbols(rows:CollectionSymbol[]):CollectionSymbol[]{
  const rank=new Map(DESKTOP_PRIORITY.map((code,i)=>[code+'-USDT-SWAP',i]))
  return rows.filter(row=>/^[A-Z0-9]{1,16}-USDT-SWAP$/.test(row.symbol))
    .sort((a,b)=>(rank.get(a.symbol)??1000)-(rank.get(b.symbol)??1000)||a.symbol.localeCompare(b.symbol)).slice(0,60)
}
export async function collectionDesktopSymbols(text=''):Promise<CollectionSymbol[]>{
  const rows=selectDesktopSymbols(await collectionSymbols()),query=text.trim().toLowerCase()
  return query?rows.filter(row=>(row.symbol+' '+row.name+' '+desktopSymbol(row.symbol)).toLowerCase().includes(query)):rows
}
export async function collectionCodeTree():Promise<CodeTreeMap>{
  const rows=await collectionDesktopSymbols(),tree:CodeTreeMap={}
  for(const row of rows){const symbol=desktopSymbol(row.symbol),code=symbol.slice(0,-4).toUpperCase();tree[code]={code,name:code+' 永续',exchange:'OKX',master:symbol,secondary:null,contracts:[{symbol,month:0,year:0,volume:0,is_master:true,is_secondary:false}]}}
  return tree
}
export async function collectionKlines(symbol:string,period:string,options?:{limit?:number;endTime?:string}){
  if(!COLLECTION_PERIODS[period])throw new Error('不支持的K线周期')
  const requested=options?.limit??300
  if(!Number.isInteger(requested)||requested<1||requested>5000)throw new Error('在线图表单次支持 1–5000 根 K 线')
  let end=options?.endTime?Math.floor(Date.parse(options.endTime.replace(' ','T')+(/Z$|[+-]\d\d:\d\d$/.test(options.endTime)?'':options.endTime.length===10?'T00:00:00+08:00':'+08:00'))/1000)-1:undefined
  if(end!==undefined&&!Number.isFinite(end))throw new Error('无效历史游标')
  const all=new Map<number,ReturnType<typeof mapCollectionBar>>()
  let hasMore=true
  while(all.size<requested){
    const count=Math.min(500,requested-all.size)
    const data=await collectionData({market_type:'crypto',exchange:'okx',symbol:collectionSymbol(symbol),operation:'history',resolution:COLLECTION_PERIODS[period],count,...(end===undefined?{}:{end})})
    const page=data.records.map(row=>mapCollectionBar(row,period)).sort((a,b)=>a.open_time!-b.open_time!)
    if(!page.length){hasMore=false;break}
    const oldest=Math.floor(page[0].open_time!/1000)
    if(end!==undefined&&oldest>end)throw new Error('历史分页游标未推进')
    const size=all.size
    for(const bar of page)all.set(bar.open_time!,bar)
    hasMore=page.length===count
    if(!hasMore)break
    if(all.size===size)throw new Error('历史分页返回重复数据')
    end=oldest-1
  }
  const bars=[...all.values()].sort((a,b)=>a.open_time!-b.open_time!)
  return {symbol,period,bars,has_more:hasMore}
}
