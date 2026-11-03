import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const auth=vi.hoisted(()=>({setState:vi.fn()}))
vi.mock('@/stores/auth',()=>({useAuthStore:auth}))
import {activateHostWorkspace} from './taskhost-workspace-profile'
import {loginHost,hostSession,logoutHost} from './taskhost-client'
import {initializeDesktopLoginSession} from './desktop-login-session'

let values:Map<string,string>
beforeEach(()=>{
  values=new Map();auth.setState.mockReset()
  const store={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}
  vi.stubGlobal('localStorage',store);vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()})
  initializeDesktopLoginSession('workspace-profile');logoutHost()
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',initialized:true}))).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',access_token:'fixture-go-token',owner_id:'owner-a',expires_at:new Date(Date.now()+300000).toISOString()}))))
})
afterEach(()=>{logoutHost();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function connect(){await loginHost('https://host.fixture','thk_'+'a'.repeat(43));return hostSession()!}
it('keeps the exact selected legacy profile, tokens and DPAPI scope',async()=>{
  const cached=JSON.stringify({id:'legacy-id',username:'Original name',role:'admin',trading_mode:'live',phone:null,email:null,avatar:null})
  values.set('qihuo_auth_user',cached);values.set('access_token','old-user-token');values.set('refresh_token','old-refresh');values.set('atd_desktop_server','https://legacy.fixture')
  const session=await connect();await activateHostWorkspace(session)
  expect(values.get('qihuo_auth_user')).toBe(cached)
  expect(values.get('access_token')).toBe('old-user-token')
  expect(values.get('refresh_token')).toBe('old-refresh')
  expect(values.get('atd_desktop_server')).toBe('https://legacy.fixture')
  expect(auth.setState).toHaveBeenCalledWith(expect.objectContaining({loaded:true,user:expect.objectContaining({id:'legacy-id'})}))
})
it('creates only a local namespaced display profile when there was no old account',async()=>{
  const session=await connect();await activateHostWorkspace(session)
  const user=JSON.parse(values.get('qihuo_auth_user')!)
  expect(user).toMatchObject({role:'user',trading_mode:'live'})
  expect(user.id).toMatch(/^taskhost:[a-f0-9]{64}$/)
  expect(values.has('access_token')).toBe(false)
  expect(values.has('refresh_token')).toBe(false)
  expect(hostSession()).toMatchObject({localProfileScope:expect.stringContaining(user.id)})
  expect(JSON.stringify([...values])).not.toContain('fixture-go-token')
})
it('does not activate a retired connection or replace an invalid existing profile',async()=>{
  const session=await connect();logoutHost()
  await expect(activateHostWorkspace(session)).rejects.toThrow('变化')
  expect(auth.setState).not.toHaveBeenCalled()
  values.set('qihuo_auth_user','invalid-kept-profile')
  await expect(activateHostWorkspace(session)).rejects.toThrow('原数据已保留')
  expect(values.get('qihuo_auth_user')).toBe('invalid-kept-profile')
})
