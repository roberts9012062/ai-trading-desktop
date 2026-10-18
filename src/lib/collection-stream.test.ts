import {it,expect,vi} from 'vitest'
import {mergeCollectionTrades, candleGroups,CollectionMarketStream} from './collection-stream'
import * as config from './collection-config'
import * as api from './collection-api'

it('replayed trades are idempotent while simultaneous trades stay distinct',()=>{
  const row={time:'12:00:00',price:100,volume:2,direction:'buy' as const,ts:'123456',source:'realtime' as const}
  const result=mergeCollectionTrades([{...row,trade_id:'a'}],[{...row,trade_id:'a'},{...row,trade_id:'b'}])
  expect(result).toHaveLength(2)
})
it('shares candle periods for the same symbol and filters invalid charts',()=>{
  expect(candleGroups([{symbol:'btcusdt',period:'1m'},{symbol:'btcusdt',period:'5m'},{symbol:'btcusdt',period:'tick'}])).toEqual([{symbol:'btcusdt',periods:['1m','5m']}])
})
it('loads the signed-in account key after an anonymous cold start',async()=>{
  const scope=vi.spyOn(config,'collectionScope').mockReturnValue('anonymous')
  const status=vi.spyOn(config,'collectionStatus').mockReturnValue({configured:false})
  vi.spyOn(config,'loadCollectionConfig').mockResolvedValue({configured:false})
  const permissions=vi.spyOn(config,'refreshCollectionPermissions').mockResolvedValue({active_packages:[]})
  const stream=new CollectionMarketStream()
  try{
    stream.connect();await Promise.resolve();await Promise.resolve()
    expect(permissions).not.toHaveBeenCalled()
    scope.mockReturnValue('signed-in-user');status.mockReturnValue({configured:true})
    stream.connect();await Promise.resolve();await Promise.resolve()
    expect(permissions).toHaveBeenCalledTimes(1)
  }finally{stream.disconnect();vi.restoreAllMocks()}
})
it('reserves candle connections for the visible chart before list quotes and stale depth',async()=>{
  vi.useFakeTimers()
  const permissions={active_packages:[{markets:['crypto'],capabilities:['stream_bars','stream_quotes','stream_ticks'],connections:5,rpm:120,expires_at:'2099-01-01',market_subscriptions:{crypto:200}}]}
  vi.spyOn(config,'collectionStatus').mockReturnValue({configured:true,permissions})
  vi.spyOn(config,'loadCollectionConfig').mockResolvedValue({configured:true,permissions})
  vi.spyOn(config,'refreshCollectionPermissions').mockResolvedValue(permissions)
  const ticket=vi.spyOn(api,'collectionTicket').mockResolvedValue({url:'/edge/ws?ticket=fixture',expires_in:45})
  vi.stubGlobal('WebSocket',class {close(){}})
  const stream=new CollectionMarketStream()
  try {
    stream.setDepthSymbols(['solusdt'])
    stream.setQuoteSymbols(Array.from({length:200},(_,i)=>`coin${i}usdt`))
    stream.setChartSubscription([{symbol:'ethusdt',period:'5m'},{symbol:'btcusdt',period:'1m'},{symbol:'solusdt',period:'1m'}])
    stream.connect();await vi.advanceTimersByTimeAsync(150)
    const queries=ticket.mock.calls.map(([query])=>query)
    expect(queries).toHaveLength(4)
    expect(queries[0]).toMatchObject({operation:'stream_bars',symbol:'ETH-USDT-SWAP'})
    expect(queries[1]).toMatchObject({operation:'stream_bars',symbol:'BTC-USDT-SWAP'})
    // Trimming excess list feeds must never remove current chart subscriptions.
    expect(queries.filter(q=>q.operation==='stream_bars')).toHaveLength(2)
  } finally {stream.disconnect();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()}
})
it('keeps the 60-contract list feed open when switching between listed contracts',async()=>{
  vi.useFakeTimers()
  const permissions={active_packages:[{markets:['crypto'],capabilities:['stream_bars','stream_quotes','stream_ticks'],connections:5,rpm:120,expires_at:'2099-01-01',market_subscriptions:{crypto:200}}]}
  vi.spyOn(config,'collectionStatus').mockReturnValue({configured:true,permissions})
  vi.spyOn(config,'loadCollectionConfig').mockResolvedValue({configured:true,permissions})
  vi.spyOn(config,'refreshCollectionPermissions').mockResolvedValue(permissions)
  const ticket=vi.spyOn(api,'collectionTicket').mockResolvedValue({url:'/edge/ws?ticket=fixture',expires_in:45})
  vi.stubGlobal('WebSocket',class {close(){}})
  const stream=new CollectionMarketStream()
  try {
    stream.setQuoteSymbols(['btcusdt','ethusdt']);stream.setChartSubscription([{symbol:'btcusdt',period:'1m'}])
    stream.connect();await vi.advanceTimersByTimeAsync(150)
    stream.setChartSubscription([{symbol:'ethusdt',period:'1m'}]);await vi.advanceTimersByTimeAsync(150)
    expect(ticket.mock.calls.filter(([q])=>q.operation==='stream_quotes')).toHaveLength(1)
  } finally {stream.disconnect();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()}
})
