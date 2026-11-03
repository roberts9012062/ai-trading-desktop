import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const f=vi.hoisted(()=>({native:true,scope:'https://old.example:profile-a',invoke:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>f.native,invoke:f.invoke}))
vi.mock('./taskhost-local-profile',()=>({selectedLocalHostProfile:()=>f.scope?{scope:f.scope,label:'Selected profile'}:null}))
import {hostSession,loginHost,logoutHost,enterStandalone} from './taskhost-client'
import {syncCurrentClientConfiguration,clientSyncStatus,invalidateClientSync,serverAccountDataFresh,serverAccountDataIssue,validServerObservation,type ServerDataAccount} from './taskhost-client-sync'
beforeEach(()=>{f.native=true;f.scope='https://old.example:profile-a';f.invoke.mockReset();vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()});vi.stubGlobal('fetch',vi.fn());logoutHost();invalidateClientSync();f.invoke.mockResolvedValue(1)})
afterEach(()=>{logoutHost();invalidateClientSync();vi.unstubAllGlobals()})
async function connect(){vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',initialized:true}))).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',access_token:'session-only',owner_id:'owner-a',expires_at:new Date(Date.now()+60000).toISOString()})));await loginHost('https://host.example','thk_'+'a'.repeat(43));vi.mocked(fetch).mockClear()}
function receipt(request:string){return {sent:true,receipt:{sync_id:request,credentials:[{client_id:'a'.repeat(64),credential_id:'12345678-1234-4234-8234-123456789001',venue:'okx',label:'OKX',demo:false,api_key_masked:'masked'}],collection_configured:true,collection_status:'pending_verification',data_status:'pending',execution_authority:false,tasks_created:false}}}
it('pins only current selected profile at successful handshake and transfers no plaintext secret through the renderer',async()=>{
 await connect();expect(hostSession()).toMatchObject({localProfileScope:f.scope});f.invoke.mockImplementation(async(command,args)=>command==='taskhost_client_sync'?receipt(args.requestId):2);vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({mode:'collection',collection_configured:true,accounts:[],execution_authority:false,refreshed_at:new Date().toISOString()})));
 await syncCurrentClientConfiguration();await syncCurrentClientConfiguration();expect(f.invoke.mock.calls.filter(([name])=>name==='taskhost_client_sync')).toHaveLength(1);expect(f.invoke.mock.calls.find(([name])=>name==='taskhost_client_sync')?.[1]).toMatchObject({scope:f.scope,origin:'https://host.example',ownerId:'owner-a',token:'session-only'});expect(JSON.stringify(f.invoke.mock.calls)).not.toContain('api_key');expect(clientSyncStatus()).toMatchObject({state:'synced',credentialCount:1});expect(fetch).toHaveBeenCalledOnce();expect(String(vi.mocked(fetch).mock.calls[0][0]).endsWith('/api/v1/data/status')).toBe(true)
})
it('never reads anonymous, another selected profile, standalone, or browser-only secrets',async()=>{
 await connect();f.invoke.mockClear();f.scope='https://old.example:profile-b';await syncCurrentClientConfiguration();expect(clientSyncStatus().state).toBe('profile_changed');expect(f.invoke).not.toHaveBeenCalled();enterStandalone({scope:'taskhost:standalone:user',centerUserID:'user'});await syncCurrentClientConfiguration();expect(f.invoke).not.toHaveBeenCalled();f.scope='';await connect();await syncCurrentClientConfiguration();expect(clientSyncStatus().state).toBe('missing_profile');f.native=false;await syncCurrentClientConfiguration();expect(clientSyncStatus().state).toBe('native_required');expect(f.invoke).not.toHaveBeenCalled()
})
it('cancels a queued native read when the active profile changes and discards old replies',async()=>{
 await connect();let complete!:(v:unknown)=>void;f.invoke.mockImplementation(async(command,args)=>command==='taskhost_client_sync'?new Promise(resolve=>{complete=resolve}):3);const pending=syncCurrentClientConfiguration();await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));f.scope='https://old.example:profile-b';complete(receipt('old-request'));await pending;expect(clientSyncStatus().state).not.toBe('synced');expect(fetch).not.toHaveBeenCalled()
})
it('publishes fixed failure diagnostics without secret exception text and retries only when explicitly requested',async()=>{
 await connect();f.invoke.mockImplementation(async(command)=>{if(command==='taskhost_client_sync')throw new Error('synthetic-private-value');return 1});await syncCurrentClientConfiguration();await syncCurrentClientConfiguration();expect(clientSyncStatus().state).toBe('unavailable');expect(JSON.stringify(clientSyncStatus())).not.toContain('synthetic-private');expect(f.invoke.mock.calls.filter(([name])=>name==='taskhost_client_sync')).toHaveLength(1);await syncCurrentClientConfiguration(true);expect(f.invoke.mock.calls.filter(([name])=>name==='taskhost_client_sync')).toHaveLength(2)
})
it('distinguishes credential rejection, fresh relay fallback and missing observation times',()=>{
 const account:ServerDataAccount={credential_id:'id',label:'account',demo:false,source:'collection',status:'ok',code:'okx_direct_unavailable',observed_at:new Date().toISOString(),stale:false,balances:[],positions:[]}
 expect(serverAccountDataFresh(account)).toBe(true);expect(serverAccountDataIssue(account)).toContain('API Collection')
 expect(serverAccountDataIssue({...account,status:'unavailable',code:'okx_credentials_rejected'})).toContain('Passphrase');expect(serverAccountDataIssue({...account,code:'okx_credentials_rejected'})).not.toContain('购买')
 expect(validServerObservation('0001-01-01T00:00:00Z')).toBe(false);expect(serverAccountDataFresh({...account,observed_at:'0001-01-01T00:00:00Z'})).toBe(false)
})
