import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const f=vi.hoisted(()=>({invoke:vi.fn(),rpc:vi.fn(),native:true,credentials:[] as any[],memory:new Map<string,string>()}))
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>f.native,invoke:f.invoke}))
vi.mock('./collection-config',()=>({collectionMode:()=>true,nativeCollection:()=>f.native,collectionScope:()=> 'https://stopped-business:user-a',collectionGeneration:()=>0,loadCollectionConfig:async()=>{},onCollectionChange:()=>()=>{}}))
vi.mock('./collection-api',()=>({collectionHttpSlot:(work:()=>Promise<unknown>)=>work()}))
vi.mock('./collection-exchange',()=>({requireCollectionPrivate:async()=>{}}))
vi.mock('./desktop-exchange',()=>({tryDesktopLiveRequest:f.rpc}))
vi.mock('./desktop-daily-pnl',()=>({loadDesktopDailyPnl:vi.fn(),resetDesktopDailyPnl:vi.fn()}))
import {saveCredentialApi,getCredentialsApi,getLivePermissionApi,getLiveAccountApi,getLivePositionsApi,getLiveOrdersApi,deleteCredentialApi,closeLivePositionApi} from './live-api'
beforeEach(()=>{
 f.native=true;f.credentials=[];f.memory=new Map([['access_token','synthetic-local-session']]);f.rpc.mockReset().mockRejectedValue(new Error('old business WS unavailable'))
 vi.stubGlobal('localStorage',{getItem:(k:string)=>f.memory.get(k)??null,setItem:(k:string,v:string)=>f.memory.set(k,v)})
 vi.stubGlobal('window',{dispatchEvent:vi.fn(),location:{}});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('old business HTTP unavailable')))
 f.invoke.mockReset().mockImplementation(async(command,a)=>{
  expect(command).toBe('desktop_local_exchange')
  if(a.path==='/api/live/credentials'){
   if(a.method==='PUT'){f.credentials=[{venue:'okx',demo:false,account_binding:null,storage:'local'}];return {ok:true,storage:'local'}}
   return {credentials:f.credentials}
  }
  if(a.path==='/api/live/credentials/okx'){f.credentials=[];return {ok:true}}
  if(a.path==='/api/live/permission')return {enabled:false,message:'read only'}
  if(!f.credentials.length)throw new Error('请在交易所接入页面配置本机 OKX 账户')
  if(a.path.startsWith('/api/live/account?'))return {equity:123,available:100,unrealized_pnl:2,demo:false,venue_name:'OKX'}
  if(a.path.startsWith('/api/live/positions?'))return {positions:[]}
  if(a.path.startsWith('/api/live/orders?'))return {orders:[],has_more:false}
  throw new Error('unexpected native path')
 })
})
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
it('saves and retains local real-account credentials, reads them and deletes them with no business request',async()=>{
 await saveCredentialApi({venue:'okx',api_key:'synthetic',secret:'synthetic',passphrase:'synthetic',demo:false})
 expect(f.credentials).toHaveLength(1)
 expect(await getCredentialsApi()).toHaveLength(1)
 await deleteCredentialApi('okx');expect(f.credentials).toHaveLength(0)
 expect(f.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})
it('reads an unbound local real account through native Collection transport while trading authorization remains disabled',async()=>{
 f.credentials=[{venue:'okx',demo:false,account_binding:null}]
 expect(await getLivePermissionApi()).toMatchObject({enabled:false})
 expect(await getLiveAccountApi('okx')).toMatchObject({total_equity:123,demo:false})
 expect(await getLivePositionsApi('okx')).toEqual([]);expect(await getLiveOrdersApi('okx',true)).toEqual([])
 await expect(closeLivePositionApi('okx','btcusdt','long')).rejects.toThrow(/仅可读取|交易授权|账户绑定/)
 expect(f.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
 expect(f.invoke.mock.calls.filter(([,a])=>a.method==='POST')).toHaveLength(0)
})
it('reports missing local credentials rather than connecting the retired business server',async()=>{
 await expect(getLiveAccountApi('okx')).rejects.toThrow('配置本机 OKX 账户')
 expect(f.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})
it('uses only business HTTP in explicit server account mode',async()=>{
 f.memory.set('atd_account_transport','server')
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({equity:88,available:70,unrealized_pnl:1,demo:false})))
 expect(await getLiveAccountApi('okx')).toMatchObject({total_equity:88})
 expect(fetch).toHaveBeenCalledOnce();expect(f.invoke).not.toHaveBeenCalled();expect(f.rpc).not.toHaveBeenCalled()
})
