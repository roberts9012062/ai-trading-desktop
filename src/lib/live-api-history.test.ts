import { afterEach, expect, it, vi } from 'vitest'
import { getLiveOrdersApi, placeLiveOrderApi } from './live-api'

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
