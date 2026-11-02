import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {enterStandalone,loginHost,hostSession,attachOnlineCenter,logoutHost} from './taskhost-client';
import {commitMigration,pendingMigration,resolveMigration,stopLegacyForMigration,inspectMigration,MigrationUncertain,type MigrationReview} from './taskhost-migration';
const bridge=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:bridge,isTauri:()=>true}));
const selection={account_id:'a'.repeat(64),task_id:'business:22222222-2222-1222-8222-222222222222',credential_id:'credential',model_id:'model'};
const review:MigrationReview={review:'b'.repeat(64),account_id:selection.account_id,task_id:selection.task_id,source_revision:'7',source_control_version:'3',checkpoint_seq:'5',epoch:'2',issues:[],mappings:[],convertible:true,center_ready:true,execution_authority:false};
beforeEach(()=>{const values=new Map<string,string>();vi.stubGlobal('sessionStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});vi.stubGlobal('fetch',vi.fn());bridge.mockReset();logoutHost();});
afterEach(()=>{logoutHost();vi.unstubAllGlobals();});
async function server(){vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',initialized:true}))).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',access_token:'fixture',owner_id:'owner',expires_at:new Date(Date.now()+60000).toISOString()})));await loginHost('https://fixture.invalid','thk_'+'a'.repeat(43));}
it('does not migrate or allocate a task offline',async()=>{enterStandalone({scope:'taskhost:standalone:user',centerUserID:'user'});await expect(commitMigration(selection,review,'migration-request-1234')).rejects.toThrow('连接服务器');expect(fetch).not.toHaveBeenCalled();});
it('locks an unknown migration and only resolves the original id without resending',async()=>{
 await server();vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fixture network'));
 await expect(commitMigration(selection,review,'migration-request-1234')).rejects.toBeInstanceOf(MigrationUncertain);expect(pendingMigration()).toBe('migration-request-1234');
 await expect(commitMigration(selection,review,'migration-request-another')).rejects.toThrow('已有结果');
 vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({task:{id:selection.task_id.split(':')[1],registration:'unknown'},execution_authority:false})));
 const task=await resolveMigration('migration-request-1234');expect(task.id).toBe(selection.task_id.split(':')[1]);expect(pendingMigration()).toBeNull();
 expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith('/migrations/commit'))).toHaveLength(1);
});
it('unlocks only a server-confirmed rejected uncommitted migration',async()=>{await server();vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({code:'migration_stage_rejected',detail:'fixture'}),{status:422}));await expect(commitMigration(selection,review,'migration-request-1234')).rejects.toThrow();expect(pendingMigration()).toBeNull();});
it('uses native shutdown receipt and the verified center scope instead of a client boolean',async()=>{
 await server();attachOnlineCenter(hostSession()!,'taskhost:standalone:user','user');bridge.mockResolvedValue({active:false,shutdown_acknowledged:true,account_id:selection.account_id});
 await expect(stopLegacyForMigration(selection.account_id)).resolves.toMatchObject({shutdown_acknowledged:true});
 expect(bridge).toHaveBeenCalledWith('taskhost_legacy_shutdown',{centerScope:'taskhost:standalone:user',accountId:selection.account_id});expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).includes('/migrations/'))).toHaveLength(0);
 bridge.mockResolvedValue({active:false,shutdown_acknowledged:true,account_id:'c'.repeat(64)});await expect(stopLegacyForMigration(selection.account_id)).rejects.toThrow('未确认');
});
it('rejects a response that supplies execution authority or changes source identity',async()=>{await server();vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({...review,execution_authority:true})));await expect(inspectMigration(selection)).rejects.toThrow('结果无效');});
