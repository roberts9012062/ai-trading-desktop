import { describe, it, expect } from 'vitest'
import { collectionSymbol, desktopSymbol, mapCollectionBar, mapCollectionTrade, ticketAddress, selectDesktopSymbols } from './collection-api'

describe('collection market boundary', () => {
  it('exposes a stable 60-contract desktop universe with BTC and ETH first', () => {
    const rows = [...Array.from({length:100},(_,i)=>({symbol:`COIN${i}-USDT-SWAP`,name:`Coin ${i}`})),{symbol:'ETH-USDT-SWAP',name:'ETH'},{symbol:'BTC-USDT-SWAP',name:'BTC'}]
    const selected=selectDesktopSymbols(rows)
    expect(selected).toHaveLength(60)
    expect(selected.slice(0,2).map(row=>row.symbol)).toEqual(['BTC-USDT-SWAP','ETH-USDT-SWAP'])
    expect(selectDesktopSymbols(rows.reverse())).toEqual(selected)
  })
  it('only maps actual OKX USDT swaps', () => {
    expect(collectionSymbol('btcusdt')).toBe('BTC-USDT-SWAP')
    expect(desktopSymbol('ETH-USDT-SWAP')).toBe('ethusdt')
    expect(() => collectionSymbol('600519')).toThrow()
  })
  it('retains absolute time, closed status and actual coin volume', () => {
    const bar=mapCollectionBar({timestamp:1792309500,open:100,high:103,low:99,close:102,volume:2,contract_volume:200,quote_volume:202,closed:false},'1m')
    expect(bar.open_time).toBe(1792309500000)
    expect(bar.volume).toBe(2)
    expect(bar.is_closed).toBe(false)
    expect(bar.quote_volume).toBe(202)
  })
  it('does not collapse different trades at the same millisecond', () => {
    const raw={timestamp:123.456,price:100,volume:2,side:'sell',volume_unit:'contracts'}
    const a=mapCollectionTrade({...raw,trade_id:'a'})
    const b=mapCollectionTrade({...raw,trade_id:'b'})
    expect(a.trade_id).not.toBe(b.trade_id)
    expect(a.direction).toBe('sell')
    expect(a.volume_unit).toBe('contracts')
  })
  it('never forwards a ticket or key to another origin', () => {
    expect(ticketAddress('/edge/ws?ticket=123')).toBe('wss://lium.eu.org/edge/ws?ticket=123')
    expect(()=>ticketAddress('https://evil.example/edge/ws?ticket=123')).toThrow()
    expect(()=>ticketAddress('/edge/ws?ticket=123&key=hidden')).toThrow()
  })
})
