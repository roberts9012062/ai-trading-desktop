import { afterEach, expect, it, vi } from 'vitest'
import { getLiveOrdersApi, getLivePositionsApi, placeLiveOrderApi } from './live-api'

afterEach(() => { vi.unstubAllGlobals();vi.useRealTimers() })
it('retries one desktop string transport failure and reads the history body', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockRejectedValueOnce('error decoding response body')
    .mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'filled',status:'filled'}]})))
  vi.stubGlobal('fetch', fetch)
  const reading = getLiveOrdersApi('okx', true)
  await vi.advanceTimersByTimeAsync(300)
  expect((await reading)[0].id).toBe('filled')
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('does not retry an authorization failure or an order submission', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:'access denied'}),{status:403}))
  vi.stubGlobal('fetch',fetch)
  await expect(getLiveOrdersApi('okx',true)).rejects.toThrow('access denied')
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockReset().mockRejectedValue('connection reset')
  await expect(placeLiveOrderApi({venue:'okx',symbol:'btcusdt',direction:'buy',offset:'open',order_type:'market',price:null,quantity:1})).rejects.toThrow('connection reset')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('retries body truncation but rejects repeated failures with their cause', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue('connection reset'))
  const reading=getLiveOrdersApi('okx',true)
  const failed=expect(reading).rejects.toThrow('connection reset')
  await vi.advanceTimersByTimeAsync(300);await failed
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('recovers when HTTP headers succeed but the desktop body stream fails', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockResolvedValueOnce({status:200,ok:true,json:()=>Promise.reject('error reading a body from connection')})
    .mockResolvedValueOnce(new Response(JSON.stringify({orders:[]})))
  vi.stubGlobal('fetch',fetch)
  const reading=getLiveOrdersApi('okx',true)
  await vi.advanceTimersByTimeAsync(300)
  expect(await reading).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('does not retry a cancelled desktop read', async () => {
  const fetch=vi.fn().mockRejectedValue('Request cancelled')
  vi.stubGlobal('fetch',fetch)
  await expect(getLiveOrdersApi('okx',true)).rejects.toThrow('Request cancelled')
  expect(fetch).toHaveBeenCalledTimes(1)
})
vi.mock('./desktop-exchange', () => ({ tryDesktopLiveRequest: async () => null }))

it('loads all advertised pages, paints the first page early and deduplicates boundary orders',async()=>{
  const partial=vi.fn()
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'200',status:'filled'},{id:'100',status:'filled'}],has_more:true,cursor:'100'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'100',status:'canceled'},{id:'50',status:'filled'}],has_more:false,cursor:'50'})))
  vi.stubGlobal('fetch',fetch)
  const orders=await getLiveOrdersApi('okx',true,partial)
  expect(orders.map(row=>row.id)).toEqual(['200','100','50'])
  expect(orders[1].status).toBe('filled')
  expect(partial.mock.calls.map(([rows])=>rows.length)).toEqual([2,3])
  expect(String(fetch.mock.calls[1][0])).toContain('cursor=100')
})

it.each([null,'100','invalid cursor'])('rejects a missing or non-advancing pagination cursor (%s)',async(cursor)=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'100',status:'filled'}],has_more:true,cursor:'100'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'50',status:'filled'}],has_more:true,cursor})))
  vi.stubGlobal('fetch',fetch)
  await expect(getLiveOrdersApi('okx',true)).rejects.toThrow('分页')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('does not report a partial history as complete if the next page fails',async()=>{
  const partial=vi.fn()
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'100',status:'filled'}],has_more:true,cursor:'100'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({detail:'history unavailable'}),{status:403}))
  vi.stubGlobal('fetch',fetch)
  await expect(getLiveOrdersApi('okx',true,partial)).rejects.toThrow('history unavailable')
  expect(partial).toHaveBeenCalledOnce()
})

it('keeps the exchange available close quantity instead of the entire frozen position',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({positions:[{symbol:'btcusdt',direction:'long',quantity:2,available_quantity:0.5}]}))))
  expect((await getLivePositionsApi('okx'))[0]).toMatchObject({quantity:2,available_quantity:0.5})
})

it('does not continue old history pagination after a login changes between pages',async()=>{
  let token='original'
  vi.stubGlobal('window',{location:{}})
  vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='access_token'?token:null})
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({orders:[{id:'100',status:'filled'}],has_more:true,cursor:'100'})))
  vi.stubGlobal('fetch',fetch)
  await expect(getLiveOrdersApi('okx',true,()=>{token='new-user'})).rejects.toThrow('已切换')
  expect(fetch).toHaveBeenCalledOnce()
})

it('loads regular and algo stages without treating an empty intermediate stage as completion',async()=>{
  const partial=vi.fn()
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'100',status:'live'}],has_more:true,cursor:'a:0:'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({orders:[],has_more:true,cursor:'a:1:'})))
    .mockResolvedValueOnce(new Response(JSON.stringify({orders:[{id:'900',algo_id:'900',order_kind:'algo',status:'live'}],has_more:false,cursor:null})))
  vi.stubGlobal('fetch',fetch)
  expect((await getLiveOrdersApi('okx',false,partial)).map(row=>row.id)).toEqual(['100','algo:900'])
  expect(partial.mock.calls.map(([rows])=>rows.length)).toEqual([1,1,2])
  expect(String(fetch.mock.calls[1][0])).toContain('cursor=a%3A0%3A')
})
