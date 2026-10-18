import {it,expect,vi} from 'vitest'
import {mergeCollectionTrades, candleGroups,CollectionMarketStream} from './collection-stream'
import * as config from './collection-config'

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
