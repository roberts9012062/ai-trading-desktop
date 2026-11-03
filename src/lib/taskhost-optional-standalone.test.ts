import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const native=vi.hoisted(()=>({invoke:vi.fn(),isTauri:vi.fn(()=>true)}))
vi.mock('@tauri-apps/api/core',()=>native)
vi.mock('./collection-config',()=>({collectionScope:vi.fn(()=> 'old-server:original-user'),loadCollectionConfig:vi.fn(async()=>({configured:false}))}))
import {loadCollectionConfig,collectionScope} from './collection-config'
import {loginStandalone,standaloneAccounts} from './taskhost-standalone'
import {hostSession,logoutHost,loginHost} from './taskhost-client'
import {initializeDesktopLoginSession,desktopLoginRequired,assertServerLoginForTasks} from './desktop-login-session'
beforeEach(()=>{native.invoke.mockReset();native.isTauri.mockReturnValue(true);vi.mocked(collectionScope).mockReturnValue('old-server:original-user');vi.mocked(loadCollectionConfig).mockResolvedValue({configured:false});vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()});initializeDesktopLoginSession('optional-key-run');logoutHost()})
afterEach(()=>{logoutHost();vi.unstubAllGlobals()})
it('allows blank-Key local entry without native credential calls or task authority',async()=>{
 await loginStandalone('')
 expect(desktopLoginRequired()).toBe(false)
 expect(hostSession()).toMatchObject({mode:'standalone',centerVerified:false,centerUserID:''})
 expect(native.invoke).not.toHaveBeenCalled()
 expect(()=>assertServerLoginForTasks()).toThrow()
 await expect(standaloneAccounts()).rejects.toThrow('Key')
})
it('uses only the selected profile saved Key through native verification and an encrypted standby binding, without exporting it',async()=>{
 vi.mocked(loadCollectionConfig).mockResolvedValue({configured:true})
 native.invoke.mockResolvedValue({configured:true,scope:'taskhost:standalone:verified-center',user_id:'verified-center'})
 await loginStandalone('')
 await vi.waitFor(()=>expect(hostSession()).toMatchObject({scope:'taskhost:standalone:verified-center',centerUserID:'verified-center',centerVerified:true}))
 expect(native.invoke).toHaveBeenCalledExactlyOnceWith('collection_key',{scope:'old-server:original-user',action:'standalone',key:null})
})
it('still opens the workspace if saved Key verification is unavailable',async()=>{
 vi.mocked(loadCollectionConfig).mockResolvedValue({configured:true});native.invoke.mockRejectedValue(new Error('fixture center unavailable'))
 await loginStandalone('')
 expect(hostSession()).toMatchObject({centerVerified:false})
 expect(desktopLoginRequired()).toBe(false)
})
it('does not require native secure storage for a Key-less local browser workspace',async()=>{
 native.isTauri.mockReturnValue(false);await loginStandalone('')
 expect(hostSession()).toMatchObject({centerVerified:false})
 expect(native.invoke).not.toHaveBeenCalled()
})
it('does not install a different standby scope from an incompatible native reply',async()=>{
 vi.mocked(loadCollectionConfig).mockResolvedValue({configured:true});native.invoke.mockResolvedValue({configured:true,scope:'taskhost:standalone:another',user_id:'verified-center'})
 await loginStandalone('');expect(hostSession()).toMatchObject({centerVerified:false,centerUserID:''})
})
it('enters immediately while saved-Key verification is pending and drops it after a newer server login',async()=>{
 vi.mocked(loadCollectionConfig).mockResolvedValue({configured:true});let release!:(value:unknown)=>void
 native.invoke.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
 await loginStandalone('');expect(desktopLoginRequired()).toBe(false);expect(hostSession()).toMatchObject({centerVerified:false})
 await vi.waitFor(()=>expect(native.invoke).toHaveBeenCalledOnce())
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({service:'taskhost-go',initialized:true})).mockResolvedValueOnce(Response.json({service:'taskhost-go',owner_id:'new-owner',access_token:'fixture',expires_at:new Date(Date.now()+60000).toISOString()})))
 await loginHost('https://host.fixture','thk_'+'a'.repeat(43))
 release({configured:true,scope:'taskhost:standalone:verified-center',user_id:'verified-center'});await Promise.resolve();await Promise.resolve()
 expect(hostSession()).toMatchObject({mode:'server',ownerID:'new-owner'})
})
it('does not search anonymous or other profiles for a saved Key',async()=>{
 vi.mocked(collectionScope).mockReturnValue('default:anonymous');vi.mocked(loadCollectionConfig).mockResolvedValue({configured:true})
 await loginStandalone('');expect(hostSession()).toMatchObject({centerVerified:false});expect(native.invoke).not.toHaveBeenCalled()
})
