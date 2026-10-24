import {expect,it} from 'vitest'
import {migrateStaleContract,useAppStore} from './app'
const tree={BTC:{code:'BTC',name:'BTC',exchange:'OKX',master:'btcusdt',secondary:null,contracts:[{symbol:'btcusdt',month:0,year:0,volume:0,is_master:true,is_secondary:false}]},ETH:{code:'ETH',name:'ETH',exchange:'OKX',master:'ethusdt',secondary:null,contracts:[{symbol:'ethusdt',month:0,year:0,volume:0,is_master:true,is_secondary:false}]}}
it('starts a fresh crypto desktop on BTC instead of the retired futures default',()=>expect(useAppStore.getState().activeContract).toBe('btcusdt'))
it('migrates old futures and delisted crypto memories to an available crypto contract',()=>{
  expect(migrateStaleContract('rb2610',tree)).toBe('btcusdt')
  expect(migrateStaleContract('oldusdt',tree)).toBe('btcusdt')
  expect(migrateStaleContract('ethusdt',tree)).toBe('ethusdt')
})
