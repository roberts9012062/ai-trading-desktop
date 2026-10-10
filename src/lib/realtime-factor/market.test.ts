import { afterEach,beforeEach,expect,it,vi } from 'vitest'
const fake=vi.hoisted(()=>({candle:vi.fn()}))
vi.mock('./api',()=>({candleTask:fake.candle}))
import { readMarketSnapshot } from './market'
import { resetSnippetRest } from '../snippet-rest'

const raw=['1791594000000','10.33','10.367','10.321','10.348','20056.1','20056.1','207494.5619','0']
const bar={time:'2026-10-10 09:00:00',open:10.33,high:10.367,low:10.321,close:10.348,volume:20056.1,is_closed:false,market_source:'okx'}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-10T01:01:00Z'));vi.clearAllMocks();resetSnippetRest();fake.candle.mockRejectedValue(new Error('server unavailable'))})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

it('accepts a fresh direct OHLCV snapshot and does not query the server when direct wins',async()=>{
  const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({code:'0',data:[raw]})})
  vi.stubGlobal('fetch',fetcher)
  const result=await readMarketSnapshot('task','avaxusdt','15m')
  expect(result).toMatchObject({source:'direct',marketAt:Date.now(),bars:[{close:10.348,volume:20056.1,is_closed:false}]})
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.candle).not.toHaveBeenCalled()
  expect(fetcher.mock.calls[0][1].cache).toBe('no-store')
})

it('recovers a blocked direct route while preserving the server cached snapshot age',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('blocked')))
  const observed=Date.now()-2500
  fake.candle.mockImplementation(async()=>({bars:[bar],observed_at:observed,server_ms:Date.now()}))
  const pending=readMarketSnapshot('task','avaxusdt','15m')
  await vi.advanceTimersByTimeAsync(500)
  const result=await pending
  expect(result.source).toBe('server')
  expect(result.marketAt).toBe(observed)
})

it('starts server recovery immediately when the direct route has already failed',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('blocked')))
  fake.candle.mockImplementation(async()=>({bars:[bar],observed_at:Date.now(),server_ms:Date.now()}))
  const pending=readMarketSnapshot('task','avaxusdt','15m')
  await vi.advanceTimersByTimeAsync(0)
  expect(fake.candle).toHaveBeenCalledTimes(1)
  expect((await pending).source).toBe('server')
})

it('does not refresh freshness using stale server snapshots',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('blocked')))
  fake.candle.mockImplementation(async()=>({bars:[bar],observed_at:Date.now()-5000,server_ms:Date.now()}))
  const pending=expect(readMarketSnapshot('task','avaxusdt','15m')).rejects.toThrow('均不可用')
  await vi.advanceTimersByTimeAsync(500)
  await pending
})

it('rejects malformed direct bars when server recovery is also unavailable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({code:'0',data:[[...raw.slice(0,4),'NaN',...raw.slice(5)]]})}))
  const pending=expect(readMarketSnapshot('task','avaxusdt','15m')).rejects.toThrow('均不可用')
  await vi.advanceTimersByTimeAsync(500)
  await pending
})

it('honors the shared direct-route cooldown after rate limiting and continues via server snapshots',async()=>{
  const fetcher=vi.fn().mockResolvedValue({ok:false,status:429,json:async()=>({code:'50011'})})
  vi.stubGlobal('fetch',fetcher)
  fake.candle.mockImplementation(async()=>({bars:[bar],observed_at:Date.now(),server_ms:Date.now()}))
  const first=readMarketSnapshot('task','avaxusdt','15m')
  await vi.advanceTimersByTimeAsync(500);expect((await first).source).toBe('server')
  const second=readMarketSnapshot('task','avaxusdt','15m')
  await vi.advanceTimersByTimeAsync(500);expect((await second).source).toBe('server')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
