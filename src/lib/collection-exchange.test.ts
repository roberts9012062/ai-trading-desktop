import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const fixture=vi.hoisted(()=>({epoch:0,authorized:true,request:vi.fn(),ticket:vi.fn()}))
vi.mock('./collection-config',()=>({COLLECTION_BASE:'https://lium.eu.org',collectionScope:()=> 'account-a',collectionGeneration:()=>fixture.epoch,loadCollectionConfig:async()=>{},collectionStatus:()=>({configured:true,permissions:{active_packages:[{markets:['crypto'],capabilities:fixture.authorized?['okx_private','okx_private_ws']:[]}]}}),collectionRequest:fixture.request}))
vi.mock('./collection-api',()=>({collectionHttpSlot:(work:()=>Promise<unknown>)=>work(),collectionTicket:fixture.ticket}))
import {forwardCollectionExchange,signedCollectionBody,collectionPrivateAddress,collectionPrivateSocketAddress} from './collection-exchange'
const frame={method:'GET',path:'/api/v5/account/bills?instType=SWAP&after=123',body:'',headers:{'OK-ACCESS-KEY':'exchange-key','OK-ACCESS-SIGN':'exact-signature','OK-ACCESS-TIMESTAMP':'2026-10-18T11:00:00.000Z','OK-ACCESS-PASSPHRASE':'phrase','x-simulated-trading':'1'}}
beforeEach(()=>{fixture.epoch=0;fixture.authorized=true;fixture.ticket.mockResolvedValue({url:'/edge/okx?ticket=one-use'});fixture.request.mockResolvedValue({raw:JSON.stringify({code:'0',data:[{eq:'12'}]})})})
afterEach(()=>vi.clearAllMocks())
it('preserves the original query, body, timestamp and signature through a single ticket redemption',async()=>{
  const result=await forwardCollectionExchange(frame)
  expect(result).toEqual({status:200,data:{code:'0',data:[{eq:'12'}]}})
  expect(fixture.ticket).toHaveBeenCalledTimes(1)
  expect(fixture.request).toHaveBeenCalledExactlyOnceWith('/edge/okx?ticket=one-use',expect.objectContaining({query:'instType=SWAP&after=123',signature:'exact-signature',timestamp:frame.headers['OK-ACCESS-TIMESTAMP'],simulated:true}))
})
it('does not repeat an ambiguous write',async()=>{
  fixture.request.mockRejectedValue(new Error('timeout'))
  await expect(forwardCollectionExchange({...frame,method:'POST',path:'/api/v5/trade/order',body:'{"instId":"BTC-USDT-SWAP","sz":"1"}'})).rejects.toThrow('timeout')
  expect(fixture.request).toHaveBeenCalledTimes(1)
})
it('rejects missing entitlements, foreign ticket URLs and unsupported money endpoints',async()=>{
  fixture.authorized=false
  await expect(forwardCollectionExchange(frame)).rejects.toThrow('未开通')
  expect(fixture.ticket).not.toHaveBeenCalled()
  expect(()=>collectionPrivateAddress('https://other.example/edge/okx?ticket=x')).toThrow()
  expect(()=>signedCollectionBody({...frame,method:'POST',path:'/api/v5/asset/withdrawal'})).toThrow()
})
it('cancels before sending a signed request after a Key change or expired caller',async()=>{
  fixture.ticket.mockImplementation(async()=>{fixture.epoch++;return {url:'/edge/okx?ticket=old'}})
  await expect(forwardCollectionExchange(frame)).rejects.toThrow('已取消')
  expect(fixture.request).not.toHaveBeenCalled()
  await expect(forwardCollectionExchange(frame,()=>false)).rejects.toThrow('已取消')
})
it('encodes the selected account environment in private WS tickets',async()=>{
  fixture.ticket.mockResolvedValue({url:'/edge/okx-ws?ticket=ws-proof'})
  expect(await collectionPrivateSocketAddress(true)).toBe('wss://lium.eu.org/edge/okx-ws?ticket=ws-proof')
  expect(fixture.ticket).toHaveBeenCalledWith(expect.objectContaining({operation:'okx_private_ws',simulated:true,seconds:45}))
})
