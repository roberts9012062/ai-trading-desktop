import {afterEach,expect,it,vi} from 'vitest'
const fixture=vi.hoisted(()=>({invoke:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({invoke:fixture.invoke}))
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();vi.clearAllMocks()})
async function setup(){
  vi.stubGlobal('window',{__TAURI_INTERNALS__:{}})
  vi.stubGlobal('localStorage',{getItem:()=>null})
  const provider=await import('./market-provider');provider.enableDirectOkxMode()
  return {provider,config:await import('./collection-config')}
}
it('uses Collection when a scoped key exists, and direct OKX only after explicit clearing',async()=>{
  fixture.invoke.mockResolvedValue({configured:true})
  const {provider,config}=await setup()
  await config.loadCollectionConfig()
  expect(provider.directOkxMode()).toBe(false)
  fixture.invoke.mockResolvedValue({configured:false})
  await config.collectionKeyAction('clear')
  expect(provider.directOkxMode()).toBe(true)
})
it('does not dial OKX while encrypted configuration is loading or unreadable',async()=>{
  let reject!:(reason:Error)=>void
  fixture.invoke.mockImplementation(()=>new Promise((_,no)=>{reject=no}))
  const {provider,config}=await setup()
  const pending=config.loadCollectionConfig()
  await Promise.resolve();await Promise.resolve()
  expect(provider.directOkxMode()).toBe(false)
  reject(new Error('unreadable encrypted key'))
  await pending
  expect(provider.directOkxMode()).toBe(false)
})
it('keeps Collection selected on service errors and permission refresh failure',async()=>{
  fixture.invoke.mockResolvedValue({configured:true})
  const {provider,config}=await setup();await config.loadCollectionConfig()
  config.collectionIssue('network unavailable')
  expect(provider.directOkxMode()).toBe(false)
  fixture.invoke.mockRejectedValue(new Error('revoked key'))
  await expect(config.refreshCollectionPermissions()).rejects.toThrow('revoked key')
  expect(provider.directOkxMode()).toBe(false)
})
it('selects direct OKX when the scoped native storage explicitly reports no key',async()=>{
  fixture.invoke.mockResolvedValue({configured:false})
  const {provider,config}=await setup();await config.loadCollectionConfig()
  expect(provider.directOkxMode()).toBe(true)
})
it('does not send an earlier account configuration into the next account scope',async()=>{
  let id='account-a'
  fixture.invoke.mockImplementation(async(_command,args)=>({configured:args.scope.endsWith('account-a')}))
  const {provider,config}=await setup()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='qihuo_auth_user'?JSON.stringify({id}):null})
  await config.loadCollectionConfig();expect(provider.directOkxMode()).toBe(false)
  id='account-b';await config.loadCollectionConfig();expect(provider.directOkxMode()).toBe(true)
  id='account-a';await config.loadCollectionConfig();expect(provider.directOkxMode()).toBe(false)
})
