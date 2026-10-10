import { OkxSnippetWebSocket } from '../okx-snippet-ws'
import { barTimeToMs } from '../binance-kline'
import { getAITradingTask, type AITradingTask } from '../ai-trading-api'
import type { KlineBar } from '@/types'
import { useRealtimeFactorStore } from '@/stores/realtime-factor'
import { useAITradingStore } from '@/stores/ai-trading'
import { useAuthStore } from '@/stores/auth'
import { FactorWorker } from './worker'
import { readMarketSnapshot } from './market'
import { seedTask, startTask, stopTask, renewTask, submitScore } from './api'
import { healthy, intentForScore, mergeCandle, refreshEnrichment, type Cadence } from './model'

const PERIOD_MS:Record<string,number>={'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'60m':3600000,'240m':14400000,'1d':86400000}
interface Session {
  task: AITradingTask
  interval: Cadence
  token: string|null
  bars: KlineBar[]
  latest: KlineBar|null
  cap: number
  offset: number
  marketAt: number
  computedAt: number
  busy: boolean
  submitting: boolean
  renewing: boolean
  stopped: boolean
  timer?: ReturnType<typeof setInterval>
  poll?: ReturnType<typeof setInterval>
  enriching: boolean
  enrichedAt: number
  marketTimer?: ReturnType<typeof setInterval>
  refreshingMarket?: boolean
}
const sessions=new Map<string,Session>()
let stream:OkxSnippetWebSocket|null=null
let worker:FactorWorker|null=null
let heartbeatTimer:ReturnType<typeof setInterval>|null=null
let generation=0
const view=()=>useRealtimeFactorStore.getState()
const same=(s:Session)=>sessions.get(s.task.id)===s && !s.stopped
const account=()=>{const u=useAuthStore.getState().user;return u?`${u.id}:${u.trading_mode}`:null}
class WaitingForCandle extends Error {}

function syncSubscriptions() {
  if (!sessions.size) {stream?.disconnect();stream=null;worker?.close();worker=null;return}
  if (!stream) {
    stream=new OkxSnippetWebSocket()
    stream.onMessage(message=>{
      if (message.type!=='chart_kline') return
      for (const frame of message.data as Array<{symbol:string;period:string;bar:KlineBar}>) {
        for (const s of sessions.values()) {
          if (s.stopped || s.task.symbol!==frame.symbol || s.task.timeframe!==frame.period) continue
          s.latest=frame.bar;s.marketAt=Date.now()
          s.bars=mergeCandle(s.bars,frame.bar,s.cap)
        }
      }
    })
  }
  stream.setChartSubscription([...sessions.values()].map(s=>({symbol:s.task.symbol,period:s.task.timeframe})))
  stream.connect()
}

function scoringWindow(s:Session) {
  if (!s.latest || Date.now()-s.marketAt>=5000) throw new Error('实时行情中断，已恢复普通模式')
  const span=PERIOD_MS[s.task.timeframe]
  const now=Date.now()+s.offset, start=barTimeToMs(s.latest.time)
  const expected=Math.floor(now/span)*span
  // OKX's daily channel starts at UTC+8 midnight, already epoch aligned for 1d
  // only after adding the UTC+8 offset before flooring.
  const dailyExpected=Math.floor((now+28800000)/span)*span-28800000
  if(start<now && now>=start+span && now<start+span+1500)throw new WaitingForCandle('等待新周期K线')
  if (start!==(s.task.timeframe==='1d'?dailyExpected:expected) || s.latest.is_closed) throw new Error('等待当前周期实时K线，已停止秒级模式')
  const rows=s.bars.filter(b=>barTimeToMs(b.time)<=start)
  const prev=rows.at(-2)
  if (prev && (start-barTimeToMs(prev.time)!==span || prev.is_closed===false)) throw new Error('K线存在缺口或尚未确认，已恢复普通模式')
  const elapsed=Math.max(1000,now-start)
  return {rows,scale:span/Math.min(span,elapsed)}
}

async function refreshMarket(s:Session) {
  if(!same(s)||s.refreshingMarket||Date.now()-s.marketAt<1500)return
  s.refreshingMarket=true
  try {
    const snapshot=await readMarketSnapshot(s.task.id,s.task.symbol,s.task.timeframe)
    if(!same(s)||snapshot.marketAt<=s.marketAt||Date.now()-snapshot.marketAt>=5000)return
    const latest=snapshot.bars.at(-1)
    if(!latest||s.latest&&latest.time<s.latest.time)return
    if(s.latest?.time===latest.time&&s.latest.is_closed&&!latest.is_closed)return
    for(const bar of snapshot.bars)s.bars=mergeCandle(s.bars,bar,s.cap)
    s.latest=latest;s.marketAt=snapshot.marketAt
  } catch { /* A failed read cannot refresh freshness or renew ownership. */ }
  finally {s.refreshingMarket=false}
}

async function score(s:Session,timeout?:number) {
  const window=scoringWindow(s)
  worker??=new FactorWorker()
  const started=Date.now()
  const result=await worker.score(s.task.strategy_params,window.rows,window.scale,timeout)
  // A result describes the input at request time, never the time computation ended.
  if (Date.now()-started>s.interval*1000+1500 || !same(s)) throw new Error('计算结果已过期')
  s.computedAt=started
  return result
}

async function step(s:Session) {
  if (!same(s) || !s.token || s.busy) return
  s.busy=true
  try {
    const value=await score(s)
    if (!same(s)) return
    const action=intentForScore(s.task,value), id=crypto.randomUUID()
    const at=s.computedAt, price=s.latest!.close
    view().record(s.task.id,{id,at,marketAt:s.marketAt,price,score:value,action,
      reason:value>0.3?'因子偏多':value< -0.3?'因子偏空':'因子观望或中性',status:action==='hold'?'观望':'提交中'})
    if (action!=='hold' && !s.submitting) void execute(s,id,at,value)
    else if(s.submitting)view().amend(s.task.id,id,{status:'委托处理中，继续计算，等待持仓同步'})
  } catch (error) {
    if(error instanceof WaitingForCandle) {
      setTimeout(()=>{if(same(s))void step(s)},250)
      return
    }
    if (same(s)) {
      const message=error instanceof Error?error.message:'秒级执行异常'
      view().record(s.task.id,{id:crypto.randomUUID(),at:Date.now(),marketAt:s.marketAt,price:s.latest?.close??0,score:null,action:'hold',reason:message,status:'停止秒级，服务器接管'})
      await stopRealtime(s.task.id,message)
    }
  } finally {s.busy=false}
}

async function execute(s:Session,id:string,at:number,value:number) {
  if(!s.token || !same(s))return
  s.submitting=true
  try {
    const result=await submitScore(s.task.id,s.token,id,Math.round(at+s.offset),value)
    if(!same(s))return
    view().amend(s.task.id,id,{action:(result.action??'hold') as 'hold'|'close'|'open_long'|'open_short',orderId:result.order_id,
      status:result.order_id?'已提交委托，成交待确认':result.action==='hold'?'未执行':'未下单',
      reason:result.reason??result.model?.reason??(result.skipped?'本次已跳过':'服务器已处理')})
    const task=await getAITradingTask(s.task.id)
    if(!same(s))return
    s.task=task
    useAITradingStore.setState(state=>({tasks:state.tasks.map(t=>t.id===task.id?task:t)}))
  } catch(error) {
    if(same(s)) {
      const reason=error instanceof Error?error.message:'委托结果待核对'
      view().amend(s.task.id,id,{status:'结果待核对，交由服务器接管',reason})
      await stopRealtime(s.task.id,reason)
    }
  } finally {s.submitting=false}
}

async function beat(s:Session) {
  if (!same(s) || !s.token || s.renewing) return
  if (!healthy(Date.now(),s.computedAt,s.marketAt,s.interval)) {
    await stopRealtime(s.task.id,'行情或计算中断，已停止续期并恢复普通模式');return
  }
  s.renewing=true
  try {
    await renewTask(s.task.id,s.token,Math.round(s.computedAt+s.offset),Math.round(s.marketAt+s.offset))
  } catch (error) {
    if (same(s)) await stopRealtime(s.task.id,error instanceof Error?error.message:'服务器连接中断，停止秒级模式')
  } finally {s.renewing=false}
}

async function refresh(s:Session) {
  if (!same(s)) return
  try {
    const task=await getAITradingTask(s.task.id)
    if (!same(s)) return
    s.task=task
    if (task.status!=='running' || !task.realtime_mode?.active) {await stopRealtime(task.id,'任务已暂停、停止或秒级执行权已失效');return}
    if (Date.now()-s.enrichedAt>60000 && !s.enriching) {
      s.enriching=true
      try {
        const seed=await seedTask(task.id)
        if (same(s)) {
          // New server history supplies slow derivatives; fresh local candles
          // override prices/volume for overlapping bars.
          s.bars=refreshEnrichment(seed.bars,s.bars,s.cap);s.enrichedAt=Date.now()
        }
      } finally {s.enriching=false}
    }
  } catch { /* Lease heartbeat, rather than display polling, decides ownership. */ }
}

export async function startRealtime(task:AITradingTask,interval:Cadence) {
  if (task.strategy_type!=='factor' || task.status!=='running') throw new Error('请先启动纯因子任务')
  if (sessions.has(task.id)) throw new Error('该任务正在启动或已开启秒级模式')
  if (!Number.isInteger(interval) || interval<1 || interval>5) throw new Error('计算间隔须为1至5秒')
  if (sessions.size>=32) throw new Error('当前客户端最多同时运行32个秒级任务')
  const owner=account(), version=generation
  if (!owner) throw new Error('请先登录')
  const s:Session={task,interval,token:null,bars:[],latest:null,cap:10000,offset:0,marketAt:0,computedAt:0,busy:false,submitting:false,renewing:false,stopped:false,enriching:false,enrichedAt:0}
  sessions.set(task.id,s);view().update(task.id,{state:'preparing',interval,message:'准备历史行情与本地计算内核…'})
  syncSubscriptions()
  s.marketTimer=setInterval(()=>void refreshMarket(s),1000)
  void refreshMarket(s)
  try {
    const seed=await seedTask(task.id)
    if (!same(s) || version!==generation || owner!==account()) throw new Error('会话已切换或启动已取消')
    s.task=seed.task;s.cap=seed.limit;s.offset=seed.server_ms-Date.now();s.enrichedAt=Date.now()
    s.bars=seed.bars
    if (s.latest) s.bars=mergeCandle(s.bars,s.latest,s.cap)
    // Wait for a fresh authoritative candle from WS or a bounded OHLCV snapshot.
    const until=Date.now()+15000
    while (same(s) && (!s.latest || Date.now()-s.marketAt>=5000) && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,100))
    worker??=new FactorWorker()
    const window=scoringWindow(s)
    await worker.score(s.task.strategy_params,window.rows,window.scale,60000) // cold warmup before acquiring a lease
    if (!same(s) || version!==generation || owner!==account()) throw new Error('会话已切换或启动已取消')
    // Recalculate against fresh input now that the worker is warm.
    await score(s)
    const lease=await startTask(task.id,interval)
    s.token=lease.token
    s.offset=lease.server_ms-Date.now()
    if (!same(s) || version!==generation || owner!==account()) {await stopTask(task.id,lease.token);throw new Error('启动已取消')}
    if (!healthy(Date.now(),s.computedAt,s.marketAt,s.interval)) throw new Error('交接期间行情或计算已过期，请重新开启')
    view().update(task.id,{state:'active',message:`秒级运行 · ${interval}秒`})
    s.timer=setInterval(()=>void step(s),interval*1000)
    s.poll=setInterval(()=>void refresh(s),5000)
    await step(s)
  } catch(error) {
    if(sessions.get(task.id)===s)await stopRealtime(task.id,error instanceof Error?error.message:'秒级模式启动失败')
    throw error
  }
}

export async function stopRealtime(id:string,message='秒级模式已关闭，恢复原任务频率') {
  const s=sessions.get(id)
  if (!s) return
  s.stopped=true
  clearInterval(s.timer);clearInterval(s.poll);clearInterval(s.marketTimer)
  view().update(id,{state:'stopping',message:'正在交还执行权…'})
  const token=s.token;s.token=null
  sessions.delete(id);syncSubscriptions()
  // Do not retry an exchange instruction. Releasing an execution lease is
  // idempotent and safe to retry while an in-flight server request finishes.
  if (token) {
    for (let attempt=0;attempt<3;attempt++) {
      try {await stopTask(id,token);break} catch {
        if (attempt<2) await new Promise(resolve=>setTimeout(resolve,500))
      }
    }
  }
  if(!sessions.has(id))view().update(id,{state:'fallback',message})
}

export function realtimeCount() {return sessions.size}
export async function stopAllRealtime(message?:string) {await Promise.allSettled([...sessions.keys()].map(id=>stopRealtime(id,message)))}

/** Mounted once in the application root, independent of trading routes. */
export function attachRealtimeRuntime() {
  heartbeatTimer??=setInterval(()=>{for(const s of sessions.values())void beat(s)},1000)
  let previous=account()
  const auth=useAuthStore.subscribe(()=>{
    const next=account()
    if(next===previous)return
    previous=next;generation++
    const changed=generation
    void stopAllRealtime('账户已切换，秒级模式已关闭').then(()=>{if(generation===changed)view().reset()})
  })
  const tasks=useAITradingStore.subscribe(state=>{
    for(const s of sessions.values()) {
      const next=state.tasks.find(t=>t.id===s.task.id)
      if (!next)continue
      s.task=next
      if(next.status!=='running')void stopRealtime(next.id,'任务已暂停或停止，秒级模式已关闭')
    }
  })
  return ()=>{auth();tasks();if(heartbeatTimer)clearInterval(heartbeatTimer);heartbeatTimer=null;generation++;void stopAllRealtime()}
}
