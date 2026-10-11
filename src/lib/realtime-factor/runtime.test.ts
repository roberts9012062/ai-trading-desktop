import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { AITradingTask } from '../ai-trading-api'

const fake=vi.hoisted(()=>({score:vi.fn(),seed:vi.fn(),start:vi.fn(),stop:vi.fn(),renew:vi.fn(),submit:vi.fn(),get:vi.fn(),snapshot:vi.fn(),feed:true,emit:()=>{}}))
vi.mock('./market',()=>({readMarketSnapshot:fake.snapshot}))
vi.mock('./worker',()=>({FactorWorker:class {score=fake.score;close=vi.fn()}}))
vi.mock('./api',()=>({seedTask:fake.seed,startTask:fake.start,stopTask:fake.stop,renewTask:fake.renew,submitScore:fake.submit}))
vi.mock('../ai-trading-api',()=>({getAITradingTask:fake.get}))
vi.mock('@/stores/auth',async()=>{const {create}=await import('zustand');return {useAuthStore:create(()=>({user:{id:'user',trading_mode:'virtual'}}))}})
vi.mock('@/stores/ai-trading',async()=>{const {create}=await import('zustand');return {useAITradingStore:create(()=>({tasks:[]}))}})
vi.mock('../okx-snippet-ws',()=>({OkxSnippetWebSocket:class {
  handler:(msg:unknown)=>void=()=>{}
  timer:ReturnType<typeof setInterval>|undefined
  onMessage(handler:(msg:unknown)=>void){this.handler=handler}
  setChartSubscription(){}
  connect(){
    fake.emit=()=>this.handler({type:'chart_kline',data:[{symbol:'avaxusdt',period:'15m',bar:candle()}]})
    if(fake.feed)fake.emit()
    this.timer??=setInterval(()=>{if(fake.feed)fake.emit()},500)
  }
  disconnect(){clearInterval(this.timer)}
}}))
import { startRealtime, stopRealtime, stopAllRealtime, realtimeCount, attachRealtimeRuntime } from './runtime'
import { useRealtimeFactorStore } from '@/stores/realtime-factor'
import { useAuthStore } from '@/stores/auth'

function candle(){return {time:'2026-10-10 10:00:00',open:20,high:22,low:19,close:21,volume:200,is_closed:false}}
const task={id:'task',strategy_type:'factor',strategy_params:{factor_tokens:[0]},symbol:'avaxusdt',timeframe:'15m',status:'running',side_mode:'both',close_rules:{},position_qty:0.005,position_direction:'short',eval_interval_sec:null} as unknown as AITradingTask
let detach:()=>void
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-10T02:01:00Z'));vi.clearAllMocks()
  fake.feed=true
  fake.snapshot.mockImplementation(async()=>({bars:[{...candle(),time:'2026-10-10 09:45:00',is_closed:true},candle()],marketAt:Date.now(),source:'snapshot'}))
  useRealtimeFactorStore.getState().reset()
  useAuthStore.setState({user:{id:'user',trading_mode:'virtual'} as never})
  fake.score.mockResolvedValue(-0.7)
  fake.seed.mockImplementation(async()=>({task:{...task},bars:[{...candle(),time:'2026-10-10 09:45:00',is_closed:true},candle()],limit:600,server_ms:Date.now()}))
  fake.start.mockImplementation(async()=>({token:'lease',interval:1,server_ms:Date.now(),expires_at:Date.now()+5000}))
  fake.stop.mockResolvedValue({released:true});fake.renew.mockImplementation(async()=>({expires_at:Date.now()+5000}))
  fake.get.mockResolvedValue({...task,realtime_mode:{active:true,interval:1}})
  fake.submit.mockResolvedValue({action:'close',order_id:'order'})
  detach=attachRealtimeRuntime()
})
afterEach(async()=>{await stopAllRealtime();detach();vi.useRealTimers()})

it('reports steady reset events, avoids chasing 0.9 and does not send unchanged scores every second',async()=>{
  const steady={...task,position_qty:0,position_direction:null,strategy_params:{entry_mode:'steady'},factor_entry:{mode:'steady' as const,pending_mode:null}}
  fake.seed.mockImplementation(async()=>({task:steady,bars:[{...candle(),time:'2026-10-10 09:45:00',is_closed:true},candle()],limit:600,server_ms:Date.now()}))
  fake.get.mockResolvedValue({...steady,realtime_mode:{active:true,interval:1}})
  fake.submit.mockResolvedValue({action:'hold'})
  fake.score.mockResolvedValue(.9)
  await startRealtime(steady,1)
  await vi.advanceTimersByTimeAsync(4000)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(useRealtimeFactorStore.getState().tasks.task.rows[0].action).toBe('hold')
  fake.score.mockResolvedValue(.5)
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.submit).toHaveBeenCalledTimes(2)
  expect(useRealtimeFactorStore.getState().tasks.task.rows[0].action).toBe('hold')
  fake.score.mockResolvedValue(.2)
  await vi.advanceTimersByTimeAsync(3000)
  expect(fake.submit).toHaveBeenCalledTimes(3)
  fake.score.mockResolvedValue(.5)
  fake.submit.mockImplementation(()=>new Promise(()=>{})) // inspect the local fresh crossing
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.submit).toHaveBeenCalledTimes(4)
  expect(useRealtimeFactorStore.getState().tasks.task.rows[0].action).toBe('open_long')
})

it('keeps calculating and renewing while a server order is in flight',async()=>{
  await startRealtime(task,1)
  expect(fake.submit).not.toHaveBeenCalled()
  let finish:(v:unknown)=>void=()=>{}
  fake.score.mockResolvedValue(0.7)
  fake.submit.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  await vi.advanceTimersByTimeAsync(4000)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.score.mock.calls.length).toBeGreaterThanOrEqual(7)
  expect(fake.renew).toHaveBeenCalled()
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
  finish({action:'close',order_id:'order'})
  await vi.advanceTimersByTimeAsync(0)
})

it('loses execution permanently after heartbeat rejection; reconnect cannot reopen it',async()=>{
  await startRealtime(task,1)
  fake.renew.mockRejectedValue(Object.assign(new Error('执行权已失效'),{status:409,code:'lease_expired'}))
  await vi.advanceTimersByTimeAsync(1000)
  expect(realtimeCount()).toBe(0)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('fallback')
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.start).toHaveBeenCalledTimes(1)
  expect(task.eval_interval_sec).toBeNull()
})

it('survives one bounded transport timeout by renewing the same still-valid lease on the next tick',async()=>{
  await startRealtime(task,3)
  fake.renew.mockImplementationOnce(async()=>{
    await new Promise(resolve=>setTimeout(resolve,1800))
    throw new Error('秒级服务器请求超时，停止续期')
  })
  await vi.advanceTimersByTimeAsync(3400)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
  expect(fake.renew).toHaveBeenCalledTimes(3)
  expect(fake.start).toHaveBeenCalledTimes(1)
})

it('stops after the last confirmed expiry when transport remains unavailable and never reacquires',async()=>{
  await startRealtime(task,3)
  fake.renew.mockRejectedValue(new Error('network unavailable'))
  await vi.advanceTimersByTimeAsync(6000)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('fallback')
  expect(fake.start).toHaveBeenCalledTimes(1)
})

it('replaces an explicitly stale in-flight heartbeat with the newer healthy sample using the same lease',async()=>{
  await startRealtime(task,3)
  let delayed=true
  fake.renew.mockImplementation(async(_id,_token,computed)=>{
    if(delayed){
      delayed=false
      await new Promise(resolve=>setTimeout(resolve,2300))
      throw Object.assign(new Error('旧的计算结果过期'),{status:409,code:'computation_stale'})
    }
    expect(Date.now()-computed).toBeLessThan(1500)
    return {expires_at:Date.now()+5000}
  })
  await vi.advanceTimersByTimeAsync(3400)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
  expect(fake.start).toHaveBeenCalledTimes(1)
  expect(fake.renew.mock.calls.at(-1)?.[1]).toBe('lease')
  expect(fake.renew.mock.calls.at(-1)?.[2]).toBeGreaterThan(fake.renew.mock.calls[1][2])
})

it('does not retry a stale heartbeat if the client has no newer calculation',async()=>{
  await startRealtime(task,5)
  fake.renew.mockRejectedValue(Object.assign(new Error('过期'),{status:409,code:'computation_stale'}))
  await vi.advanceTimersByTimeAsync(1000)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('fallback')
  expect(fake.renew).toHaveBeenCalledTimes(2)
  expect(fake.start).toHaveBeenCalledTimes(1)
})

it('gracefully releases the exact token and preserves at most 50 analyses',async()=>{
  await startRealtime(task,1)
  await vi.advanceTimersByTimeAsync(55000)
  expect(useRealtimeFactorStore.getState().tasks.task.rows).toHaveLength(50)
  await stopRealtime(task.id)
  expect(fake.stop).toHaveBeenCalledWith('task','lease')
  expect(realtimeCount()).toBe(0)
})

it('cancelling a startup prevents later seed completion from acquiring ownership',async()=>{
  let finish:(v:unknown)=>void=()=>{}
  const seed=await fake.seed()
  fake.seed.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const start=startRealtime(task,1)
  const rejection=expect(start).rejects.toThrow()
  await stopRealtime(task.id)
  finish(seed)
  await rejection
  expect(fake.start).not.toHaveBeenCalled()
})

it('starts and keeps computing from fresh snapshots when a symbol has no websocket pushes',async()=>{
  fake.feed=false
  const starting=startRealtime(task,1)
  await vi.advanceTimersByTimeAsync(3000)
  await starting
  await vi.advanceTimersByTimeAsync(15000)
  expect(fake.snapshot).toHaveBeenCalled()
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
  expect(fake.score.mock.calls.length).toBeGreaterThan(15)
  expect(fake.renew).toHaveBeenCalled()
  expect(fake.submit).not.toHaveBeenCalled()
})

it('does not mistake an eight-second websocket silence for a lost market connection',async()=>{
  await startRealtime(task,1)
  fake.feed=false
  await vi.advanceTimersByTimeAsync(12000)
  expect(fake.snapshot).toHaveBeenCalled()
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
})

it('still falls back when both websocket and fresh snapshots are unavailable',async()=>{
  await startRealtime(task,1)
  fake.feed=false
  fake.snapshot.mockRejectedValue(new Error('snapshot unreachable'))
  await vi.advanceTimersByTimeAsync(6000)
  expect(realtimeCount()).toBe(0)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('fallback')
  expect(fake.start).toHaveBeenCalledTimes(1)
})

it('waits for a busy task handoff without resetting the enabled preparation state',async()=>{
  let attempts=0
  fake.start.mockImplementation(async()=>{
    if(++attempts<3)throw Object.assign(new Error('任务正在处理订单或模式交接，请稍后重试'),{status:409,code:'execution_busy'})
    return {token:'lease',interval:3,server_ms:Date.now(),expires_at:Date.now()+5000}
  })
  const starting=startRealtime(task,3)
  const completed=starting.catch(e=>e)
  await vi.advanceTimersByTimeAsync(500)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('preparing')
  expect(useRealtimeFactorStore.getState().tasks.task.message).toContain('等待')
  await vi.advanceTimersByTimeAsync(4000)
  expect(await completed).toBeUndefined()
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
  expect(fake.start).toHaveBeenCalledTimes(3)
})

it('calibrates heartbeat timestamps across a slow handoff instead of stopping healthy three-second analysis',async()=>{
  const offset=4200
  fake.seed.mockImplementation(async()=>({task:{...task},bars:[{...candle(),time:'2026-10-10 09:45:00',is_closed:true},candle()],limit:600,server_ms:Date.now()+offset}))
  fake.start.mockImplementation(async()=>{
    const received=Date.now()+offset+2000
    await new Promise(r=>setTimeout(r,4000))
    return {token:'lease',interval:3,server_received_ms:received,server_ms:received,expires_at:received+5000}
  })
  fake.renew.mockImplementation(async(_id,_token,computed,market)=>{
    const now=Date.now()+offset
    if(now-computed>4500||now-market>=5000||Math.max(computed,market)>now+1000)throw new Error('行情或计算已中断，停止秒级续期')
    return {expires_at:now+5000}
  })
  const starting=startRealtime(task,3)
  await vi.advanceTimersByTimeAsync(4000);await starting
  await vi.advanceTimersByTimeAsync(16000)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('active')
  expect(useRealtimeFactorStore.getState().tasks.task.rows.length).toBeGreaterThan(4)
  expect(fake.renew).toHaveBeenCalledTimes(17)
})

it('cancels a waiting handoff without acquiring ownership after the task becomes free',async()=>{
  fake.start.mockRejectedValue(Object.assign(new Error('busy'),{status:409,code:'execution_busy'}))
  const starting=startRealtime(task,3)
  const rejected=expect(starting).rejects.toThrow('取消')
  await vi.advanceTimersByTimeAsync(500)
  await stopRealtime(task.id)
  await vi.advanceTimersByTimeAsync(2000);await rejected
  expect(fake.start).toHaveBeenCalledTimes(1)
  expect(fake.renew).not.toHaveBeenCalled()
  expect(realtimeCount()).toBe(0)
})

it('never retries an ambiguous start timeout or another owner conflict',async()=>{
  fake.start.mockRejectedValue(new Error('Request cancelled'))
  await expect(startRealtime(task,3)).rejects.toThrow('Request cancelled')
  await vi.advanceTimersByTimeAsync(5000)
  expect(fake.start).toHaveBeenCalledTimes(1)
})

it('does not resurrect the preparing UI when a pending busy reply arrives after cancellation',async()=>{
  let reject:(reason:Error)=>void=()=>{}
  fake.start.mockImplementation(()=>new Promise((_resolve,no)=>{reject=no}))
  const starting=startRealtime(task,3)
  const rejected=expect(starting).rejects.toThrow('取消')
  await vi.advanceTimersByTimeAsync(0)
  await stopRealtime(task.id)
  reject(Object.assign(new Error('busy'),{status:409,code:'execution_busy'}))
  await vi.advanceTimersByTimeAsync(1500);await rejected
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('fallback')
})
