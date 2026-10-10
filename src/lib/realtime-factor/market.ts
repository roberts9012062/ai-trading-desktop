import type { KlineBar } from '@/types'
import { snippetPublicGet } from '../snippet-rest'
import { decodeOkxCandle } from '../okx-snippet-ws'
import { candleTask } from './api'

const periods:Record<string,string>={'1m':'1m','5m':'5m','15m':'15m','30m':'30m','60m':'1H','240m':'4H','1d':'1D'}
export interface MarketSnapshot {bars:KlineBar[];marketAt:number;source:'direct'|'server'}

/** A quiet candle channel is not a disconnected market. Refresh its actual
 * OHLCV snapshot, never substitute a ticker for the forming candle. */
export async function readMarketSnapshot(id:string,symbol:string,period:string):Promise<MarketSnapshot> {
  if(!/^[a-z0-9]{1,16}usdt$/.test(symbol)||!periods[period])throw new Error('不支持的实时行情品种或周期')
  const direct=async():Promise<MarketSnapshot>=>{
    const began=Date.now()
    const params=new URLSearchParams({instId:symbol.slice(0,-4).toUpperCase()+'-USDT-SWAP',bar:periods[period],limit:'3'})
    const rows=await snippetPublicGet(`/api/v5/market/candles?${params}`,2000)
    if(!rows.length)throw new Error('直连OKX快照不可用')
    const bars=rows.map(row=>decodeOkxCandle(row,period,began))
    if(bars.some((bar:KlineBar|null)=>bar===null)||Date.now()-began>=5000)throw new Error('直连OKX快照异常或过期')
    return {bars:(bars as KlineBar[]).sort((a,b)=>a.time.localeCompare(b.time)),marketAt:began,source:'direct'}
  }
  const server=async():Promise<MarketSnapshot>=>{
    const began=Date.now(),data=await candleTask(id)
    const age=data.server_ms-data.observed_at
    if(!Number.isFinite(age)||age<0||age>=5000||!data.bars.length||data.bars.some(b=>b.market_source!=='okx'))throw new Error('服务器OKX快照异常或过期')
    const marketAt=Math.min(began,Date.now()-age)
    if(Date.now()-marketAt>=5000)throw new Error('服务器OKX快照已过期')
    return {bars:data.bars,marketAt,source:'server'}
  }
  // Give the desktop direct route a head start. A bounded server hedge keeps
  // users whose network blocks the public proxy from losing healthy ownership.
  let timer:ReturnType<typeof setTimeout>|undefined
  const recovery=new Promise<MarketSnapshot>((resolve,reject)=>{
    timer=setTimeout(()=>{void server().then(resolve,reject)},500)
  })
  try {return await Promise.any([direct(),recovery])}
  catch {throw new Error('直连和服务器最新OKX行情均不可用')}
  finally {clearTimeout(timer)}
}
