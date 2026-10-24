import 'fake-indexeddb/auto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { KlineBar } from '@/types'
const state=vi.hoisted(()=>({now:Date.parse('2026-10-24T00:10:20Z'),generation:0,read:vi.fn()}))
vi.mock('./collection-config',()=>({COLLECTION_BASE:'https://lium.eu.org',collectionMode:()=>true,collectionScope:()=> 'session-user',collectionGeneration:()=>state.generation,loadCollectionConfig:async()=>({configured:true}),nativeCollection:()=>false}))
vi.mock('./collection-api',()=>({collectionKlines:state.read,collectionSymbol:(s:string)=>s.replace('usdt','-USDT-SWAP').toUpperCase(),collectionDesktopSymbols:async()=>[{symbol:'BTC-USDT-SWAP'}]}))
import { getKlineApi } from './api'
import { readCollectionChartCache,startCollectionChartCacheWarmup,collectionChartWarmupStatus } from './collection-chart-cache'
import { openDb,idbPut,KLINE_HISTORY_STORE } from './idb'

const makeBar=(t:number):KlineBar=>({time:new Date(t+28800000).toISOString().replace('T',' ').slice(0,19),open_time:t,open:10,high:12,low:9,close:11,volume:1,market_source:'okx',is_closed:true})
beforeEach(async()=>{
  vi.spyOn(Date,'now').mockImplementation(()=>state.now)
  state.generation++
  const latest=Math.floor(state.now/60000)*60000
  const bars=Array.from({length:4321},(_,i)=>makeBar(latest-(4320-i)*60000))
  bars.splice(100,1)
  await idbPut((await openDb())!,KLINE_HISTORY_STORE,{key:'collection-chart-v1:https://lium.eu.org:okx:BTC-USDT-SWAP:1m',schema:1,symbol:'btcusdt',period:'1m',bars,savedAt:state.now})
  state.read.mockReset().mockImplementation(async(symbol,period,options)=>{const end=options.endTime?Date.parse(options.endTime)-2000:latest;return {symbol,period,bars:Array.from({length:options.limit},(_,i)=>makeBar(end-(options.limit-i-1)*60000)),has_more:true}})
})
afterEach(()=>vi.restoreAllMocks())
it('switching a cached symbol fetches only the latest candles and leaves deep verification to startup',async()=>{
  const page=await getKlineApi('btcusdt','1m',{limit:240})
  expect(state.read.mock.calls.map(([, , options])=>options.limit)).toEqual([2])
  expect(page.bars.length).toBe(4320)
})

it('verifies startup gaps once per session and does not repeat the pass on reconnection',async()=>{
  await startCollectionChartCacheWarmup(['btcusdt'],['1m'])
  expect(state.read.mock.calls.map(([, , options])=>options.limit)).toEqual([2,1])
  expect(collectionChartWarmupStatus()).toMatchObject({running:false,done:1,total:1,failed:0})
  state.read.mockClear()
  await startCollectionChartCacheWarmup(['btcusdt'],['1m'])
  expect(state.read).not.toHaveBeenCalled()
})

it('reads local candles immediately while a tail request is still waiting for the network',async()=>{
  let finish!:(page:unknown)=>void
  state.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const refreshing=getKlineApi('btcusdt','1m',{limit:240})
  await vi.waitFor(()=>expect(state.read).toHaveBeenCalledOnce())
  expect((await readCollectionChartCache('btcusdt','1m'))?.bars).toHaveLength(4320)
  finish({symbol:'btcusdt',period:'1m',bars:[makeBar(Math.floor(state.now/60000)*60000)],has_more:true})
  await refreshing
})

it('continues other startup entries after a failed entry and reports failures',async()=>{
  const real=state.read.getMockImplementation()!
  state.read.mockImplementation((...args)=>{if(args[0]==='badusdt')return Promise.reject(new Error('network'));return real(...args)})
  await startCollectionChartCacheWarmup(['badusdt','btcusdt'],['1m'])
  expect(collectionChartWarmupStatus()).toMatchObject({running:false,done:2,total:2,failed:1})
})
