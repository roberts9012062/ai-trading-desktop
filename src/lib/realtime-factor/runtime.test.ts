import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { AITradingTask } from '../ai-trading-api'

const fake=vi.hoisted(()=>({score:vi.fn(),seed:vi.fn(),start:vi.fn(),stop:vi.fn(),renew:vi.fn(),submit:vi.fn(),get:vi.fn(),emit:()=>{}}))
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
    fake.emit()
    this.timer??=setInterval(()=>fake.emit(),500)
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
  useRealtimeFactorStore.getState().reset()
  useAuthStore.setState({user:{id:'user',trading_mode:'virtual'} as never})
  fake.score.mockResolvedValue(-0.7)
  fake.seed.mockImplementation(async()=>({task:{...task},bars:[{...candle(),time:'2026-10-10 09:45:00',is_closed:true},candle()],limit:600,server_ms:Date.now()}))
  fake.start.mockImplementation(async()=>({token:'lease',interval:1,server_ms:Date.now(),expires_at:Date.now()+5000}))
  fake.stop.mockResolvedValue({released:true});fake.renew.mockResolvedValue({expires_at:0})
  fake.get.mockResolvedValue({...task,realtime_mode:{active:true,interval:1}})
  fake.submit.mockResolvedValue({action:'close',order_id:'order'})
  detach=attachRealtimeRuntime()
})
afterEach(async()=>{await stopAllRealtime();detach();vi.useRealTimers()})

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
  fake.renew.mockRejectedValue(new Error('执行权已失效'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(realtimeCount()).toBe(0)
  expect(useRealtimeFactorStore.getState().tasks.task.state).toBe('fallback')
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.start).toHaveBeenCalledTimes(1)
  expect(task.eval_interval_sec).toBeNull()
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
