import {it,expect,vi} from 'vitest'
import {enableCollectionMode,collectionKeyAction} from './collection-config'
import {collectionKlines,collectionSymbols} from './collection-api'
import {CollectionMarketStream} from './collection-stream'

// Opt-in only: no shared credentials and no network in the normal test suite.
it.skipIf(!process.env.COLLECTION_LIVE_KEY)('loads the real catalog, candles, depth and directional trades, then renews 45s tickets',async()=>{
  vi.stubGlobal('window',{__TAURI_INTERNALS__:undefined})
  vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='qihuo_auth_user'?JSON.stringify({id:'integration-test'}):null})
  const original=globalThis.fetch
  vi.stubGlobal('fetch',(input:string|URL,options?:RequestInit)=>original(String(input).replace(/^\/__collection__/,'https://lium.eu.org'),options))
  enableCollectionMode()
  const state=await collectionKeyAction('save',process.env.COLLECTION_LIVE_KEY)
  expect(state.configured).toBe(true)
  const symbols=await collectionSymbols('BTC-USDT-SWAP')
  expect(symbols[0].tick_size).toBeTruthy()
  const history=await collectionKlines('btcusdt','1m',{limit:3})
  expect(history.bars).toHaveLength(3)
  expect(history.bars[0].market_source).toBe('okx')
  const stream=new CollectionMarketStream(),seen=new Map<string,number>(),periods=new Set<string>()
  const started=Date.now()
  stream.onMessage(message=>{
    seen.set(message.type,Date.now())
    if(message.type==='chart_kline')for(const frame of message.data as {period:string}[])periods.add(frame.period)
  })
  stream.setQuoteSymbols(['btcusdt','ethusdt'])
  stream.setDepthSymbols(['btcusdt'])
  stream.setChartSubscription(['1m','5m','15m','30m','60m','240m','1d'].map(period=>({symbol:'btcusdt',period})))
  stream.connect()
  try{
    await vi.waitFor(()=>{
      for(const kind of ['quote','orderbook','trades','chart_kline'])expect(seen.has(kind)).toBe(true)
      expect(periods.size).toBe(7)
    },{timeout:35000,interval:250})
    await vi.waitFor(()=>{expect(seen.get('chart_kline')||0).toBeGreaterThan(started+50000);expect(seen.get('trades')||0).toBeGreaterThan(started+50000)},{timeout:65000,interval:500})
  }finally{stream.disconnect();await collectionKeyAction('clear');vi.unstubAllGlobals()}
},110000)
