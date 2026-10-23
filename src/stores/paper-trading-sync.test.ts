import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePaperTradingStore } from './paper-trading'
import { useAuthStore } from './auth'
import * as api from '@/lib/live-api'
import type { User } from '@/types'
import type { PaperPositionItem, PaperOrderItem } from '@/lib/paper-api'
import {PendingManualControlError} from '@/lib/local-control-intent'

vi.mock('@/lib/live-api', async original => ({...await original<typeof import('@/lib/live-api')>(), getLiveAccountApi:vi.fn(),getLiveOrdersApi:vi.fn(),getLivePositionsApi:vi.fn(),placeLiveOrderApi:vi.fn(),cancelLiveOrderApi:vi.fn(),closeLivePositionApi:vi.fn()}))
const refresh=usePaperTradingStore.getState().refresh
const position={id:'new',symbol:'btcusdt',quantity:1} as PaperPositionItem
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
async function flush(){for(let n=0;n<15;n++)await Promise.resolve()}
beforeEach(()=>{
 vi.clearAllMocks();usePaperTradingStore.setState({refresh});usePaperTradingStore.getState().reset()
 useAuthStore.setState({user:{id:'owner',trading_mode:'live'} as User})
 vi.mocked(api.getLiveAccountApi).mockResolvedValue({} as Awaited<ReturnType<typeof api.getLiveAccountApi>>)
 vi.mocked(api.getLiveOrdersApi).mockResolvedValue([])
 vi.mocked(api.getLivePositionsApi).mockResolvedValue([position])
 vi.mocked(api.cancelLiveOrderApi).mockReset().mockResolvedValue(undefined)
 vi.mocked(api.closeLivePositionApi).mockReset().mockResolvedValue(undefined)
})
afterEach(()=>vi.restoreAllMocks())
it('shows positions while a slow order history is still loading',async()=>{
 const slow=deferred<[]>();vi.mocked(api.getLiveOrdersApi).mockImplementation((_v,history)=>history?slow.promise:Promise.resolve([]))
 const reading=refresh();await flush()
 expect(usePaperTradingStore.getState().positions).toEqual([position])
 slow.resolve([]);await reading
})
it('coalesces repeated refreshes for the same account',async()=>{
 const slow=deferred<PaperPositionItem[]>();vi.mocked(api.getLivePositionsApi).mockReturnValue(slow.promise)
 const one=refresh(),two=refresh();await flush()
 expect(api.getLivePositionsApi).toHaveBeenCalledTimes(1)
 slow.resolve([position]);await Promise.all([one,two])
})
it('returns an order ACK without waiting for a background refresh',async()=>{
 const slow=deferred<void>();usePaperTradingStore.setState({refresh:()=>slow.promise})
 vi.mocked(api.placeLiveOrderApi).mockResolvedValue({id:'ack',status:'live',symbol:'btcusdt',quantity:1})
 let completed=false
 const action=usePaperTradingStore.getState().place({symbol:'btcusdt',symbolName:'BTC',action:'buy',orderType:'market',price:100,quantity:1,positionDirection:null}).then(result=>{completed=true;return result})
 await flush()
 try {expect(completed).toBe(true)}finally{slow.resolve();await action}
 expect((await action)?.status).toBe('live')
})
it('ignores a previous account response even after switching back',async()=>{
 const slow=deferred<PaperPositionItem[]>();vi.mocked(api.getLivePositionsApi).mockReturnValue(slow.promise)
 const reading=refresh();await flush()
 useAuthStore.setState({user:{id:'other',trading_mode:'live'} as User})
 useAuthStore.setState({user:{id:'owner',trading_mode:'live'} as User})
 slow.resolve([position]);await reading
 expect(usePaperTradingStore.getState().positions).toEqual([])
})
it('a position event refreshes positions without querying balances or historical orders',async()=>{
 await refresh({sections:['positions']})
 expect(api.getLivePositionsApi).toHaveBeenCalledTimes(1)
 expect(api.getLiveAccountApi).not.toHaveBeenCalled()
 expect(api.getLiveOrdersApi).not.toHaveBeenCalled()
})
it('does not paint an old account order ACK into a new login',async()=>{
 const slow=deferred<Record<string,unknown>>();vi.mocked(api.placeLiveOrderApi).mockReturnValue(slow.promise)
 const action=usePaperTradingStore.getState().place({symbol:'btcusdt',symbolName:'BTC',action:'buy',orderType:'market',price:100,quantity:1,positionDirection:null})
 await flush();useAuthStore.setState({user:{id:'other',trading_mode:'live'} as User})
 slow.resolve({id:'old-order',status:'live'});await action
 expect(usePaperTradingStore.getState().orders).toEqual([])
})
it('keeps a position read failure visible until positions recover',async()=>{
 vi.mocked(api.getLivePositionsApi).mockRejectedValue(new Error('positions unavailable'))
 await refresh({sections:['positions']})
 await refresh({sections:['account']})
 expect(usePaperTradingStore.getState().error).toContain('positions unavailable')
 vi.mocked(api.getLivePositionsApi).mockResolvedValue([position])
 await refresh({sections:['positions']})
 expect(usePaperTradingStore.getState().error).toBeNull()
})
it('a late full refresh cannot overwrite a newer pushed position refresh',async()=>{
 const slow=deferred<PaperPositionItem[]>()
 vi.mocked(api.getLivePositionsApi).mockReturnValueOnce(slow.promise).mockResolvedValueOnce([position])
 const old=refresh();await flush()
 await refresh({sections:['positions']})
 slow.resolve([{...position,id:'old'}]);await old
 expect(usePaperTradingStore.getState().positions).toEqual([position])
})
it('keeps same-account history on a failed update and isolates its error from trading',async()=>{
 const old={id:'past',symbol:'btcusdt',status:'filled',filled_qty:1} as PaperOrderItem
 usePaperTradingStore.setState({orders:[old]})
 vi.mocked(api.getLiveOrdersApi).mockImplementation((_v,history)=>history?Promise.reject('connection reset'):Promise.resolve([]))
 await refresh({sections:['orders']})
 expect(usePaperTradingStore.getState().orders).toEqual([old])
 expect(usePaperTradingStore.getState().error).toBeNull()
 expect(usePaperTradingStore.getState().historyError).toContain('connection reset')
 vi.mocked(api.getLiveOrdersApi).mockResolvedValue([])
 await refresh({sections:['orders']})
 expect(usePaperTradingStore.getState().historyError).toBeNull()
 expect(usePaperTradingStore.getState().orders).toEqual([])
})

it('paints completed history pages while older records load and ignores stale account progress',async()=>{
 const slow=deferred<PaperOrderItem[]>(),past={id:'first-page',exchange_order_id:'first-page',symbol:'btcusdt',status:'filled'} as PaperOrderItem
 let progress!:(rows:PaperOrderItem[])=>void
 vi.mocked(api.getLiveOrdersApi).mockImplementation((_venue,history,onPage)=>{
  if(!history)return Promise.resolve([])
  progress=onPage!;return slow.promise
 })
 const reading=refresh();await flush()
 progress([past]);await flush()
 expect(usePaperTradingStore.getState().orders.map(row=>row.id)).toEqual(['first-page'])
 useAuthStore.setState({user:{id:'other',trading_mode:'live'} as User})
 progress([past]);slow.resolve([past]);await reading
 expect(usePaperTradingStore.getState().orders).toEqual([])
})

it('halts bulk cancellation on an uncertain command instead of hiding it and sending the rest',async()=>{
 usePaperTradingStore.setState({mode:'live',orders:[{id:'1',exchange_order_id:'1',symbol:'btcusdt',status:'pending'},{id:'2',exchange_order_id:'2',symbol:'ethusdt',status:'pending'}] as PaperOrderItem[]})
 vi.mocked(api.cancelLiveOrderApi).mockRejectedValue(new Error('上一笔交易结果尚未确认'))
 await usePaperTradingStore.getState().cancelAllPending()
 expect(api.cancelLiveOrderApi).toHaveBeenCalledOnce()
 expect(usePaperTradingStore.getState().error).toContain('尚未确认')
 expect(usePaperTradingStore.getState().lastMessage).toContain('暂停后续撤单')
})

it('shows queued manual closing as pending without claiming a completed close',async()=>{
 usePaperTradingStore.setState({mode:'live',positions:[position]})
 vi.mocked(api.closeLivePositionApi).mockRejectedValue(new PendingManualControlError('人工请求排队中'))
 await usePaperTradingStore.getState().closePosition({...position,direction:'long'},0,'market',1)
 expect(usePaperTradingStore.getState().error).toBeNull()
 expect(usePaperTradingStore.getState().lastMessage).toBe('人工请求排队中')
 expect(usePaperTradingStore.getState().positions).toEqual([position])
})

it('never sends remaining old-account cancellations after a login switch',async()=>{
 const slow=deferred<void>()
 usePaperTradingStore.setState({mode:'live',orders:[{id:'1',symbol:'btcusdt',status:'pending'},{id:'2',symbol:'ethusdt',status:'pending'}] as PaperOrderItem[]})
 vi.mocked(api.cancelLiveOrderApi).mockReturnValue(slow.promise)
 const action=usePaperTradingStore.getState().cancelAllPending();await flush()
 useAuthStore.setState({user:{id:'other',trading_mode:'live'} as User})
 slow.resolve();await action
 expect(api.cancelLiveOrderApi).toHaveBeenCalledOnce()
 expect(usePaperTradingStore.getState().lastMessage).toBeNull()
})

it('does not paint an old-account close confirmation into a new login',async()=>{
 const slow=deferred<void>();vi.mocked(api.closeLivePositionApi).mockReturnValue(slow.promise)
 usePaperTradingStore.setState({mode:'live'})
 const action=usePaperTradingStore.getState().closePosition({...position,direction:'long'},0,'market',1);await flush()
 useAuthStore.setState({user:{id:'other',trading_mode:'live'} as User})
 slow.resolve();await action
 expect(usePaperTradingStore.getState().lastMessage).toBeNull()
})
