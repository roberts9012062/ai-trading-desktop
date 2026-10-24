import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const fixture=vi.hoisted(()=>({invoke:vi.fn(),ticket:vi.fn(),request:vi.fn(),load:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({invoke:fixture.invoke}))
vi.mock('./collection-config',()=>({COLLECTION_BASE:'https://lium.eu.org',collectionScope:()=> 'fixture',collectionGeneration:()=>0,nativeCollection:()=>true,loadCollectionConfig:fixture.load,collectionStatus:()=>({configured:false}),collectionRequest:fixture.request}))
vi.mock('./collection-api',()=>({collectionHttpSlot:(work:()=>Promise<unknown>)=>work(),collectionTicket:fixture.ticket}))
beforeEach(async()=>{vi.resetModules();vi.clearAllMocks();const {enableDirectOkxMode}=await import('./market-provider');enableDirectOkxMode()})
afterEach(()=>vi.resetModules())
const frame={method:'GET',path:'/api/v5/account/positions?instType=SWAP',body:'',headers:{'OK-ACCESS-KEY':'fixture-key','OK-ACCESS-SIGN':'signed','OK-ACCESS-TIMESTAMP':'2026-10-24T00:00:00Z','OK-ACCESS-PASSPHRASE':'fixture','x-simulated-trading':'1'}}
it('reads signed account data through native OKX without a collection key or ticket',async()=>{
  fixture.invoke.mockResolvedValue({code:'0',data:[]})
  const api=await import('./collection-exchange')
  await expect(api.forwardCollectionExchange(frame)).resolves.toEqual({status:200,data:{code:'0',data:[]}})
  expect(fixture.invoke).toHaveBeenCalledExactlyOnceWith('okx_signed_read',{request:expect.objectContaining({method:'GET',path:'/api/v5/account/positions',query:'instType=SWAP',simulated:true,signature:'signed'})})
  expect(fixture.ticket).not.toHaveBeenCalled();expect(fixture.request).not.toHaveBeenCalled();expect(fixture.load).not.toHaveBeenCalled()
})
it('opens official demo private WS without an entitlement lookup',async()=>{
  const api=await import('./collection-exchange')
  await expect(api.requireCollectionPrivate()).resolves.toBeUndefined()
  await expect(api.collectionPrivateSocketAddress(true)).resolves.toBe('wss://wspap.okx.com/ws/v5/private')
  expect(fixture.ticket).not.toHaveBeenCalled();expect(fixture.load).not.toHaveBeenCalled()
})
it('does not route a financial write through the new direct-read IPC',async()=>{
  fixture.ticket.mockRejectedValue(new Error('coordinator required'))
  const api=await import('./collection-exchange')
  await expect(api.forwardCollectionExchange({...frame,method:'POST',path:'/api/v5/trade/order',body:'{}'})).rejects.toThrow('coordinator required')
  expect(fixture.invoke).not.toHaveBeenCalled()
})
