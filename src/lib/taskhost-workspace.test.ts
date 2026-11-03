import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {loginHost,logoutHost,hostSession,restoreHostSession,enterStandalone} from './taskhost-client'
import {initializeDesktopLoginSession,desktopLoginRequired,desktopSessionLocalOnly,completeDesktopLogin,assertServerLoginForTasks} from './desktop-login-session'
import {serverAccountMode} from './account-transport'

function storage(){const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value)},removeItem:(key:string)=>{map.delete(key)},map}}
let local:ReturnType<typeof storage>,session:ReturnType<typeof storage>
beforeEach(()=>{
  local=storage();session=storage()
  vi.stubGlobal('localStorage',local);vi.stubGlobal('sessionStorage',session)
  initializeDesktopLoginSession('workspace-process',session);logoutHost()
  local.setItem('qihuo_auth_user',JSON.stringify({id:'old-local-profile',username:'Saved profile',trading_mode:'live'}))
  local.setItem('atd_desktop_server','https://legacy.example')
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',initialized:true}))).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',access_token:'fixture-go-session',owner_id:'verified-owner',expires_at:new Date(Date.now()+300000).toISOString()}))))
})
afterEach(()=>{logoutHost();vi.unstubAllGlobals()})
async function connect(){await loginHost('https://host.example','thk_'+'a'.repeat(43))}
it('opens the desktop launch gate after Go handshake without manufacturing a legacy JWT',async()=>{
  await connect()
  expect(desktopLoginRequired()).toBe(false)
  expect(local.getItem('access_token')).toBeNull()
  expect(local.getItem('qihuo_auth_user')).toContain('old-local-profile')
  expect(hostSession()).toMatchObject({mode:'server',ownerID:'verified-owner'})
})
it('does not authorize the old task engine using a Go desktop connection',async()=>{
  await connect()
  expect(()=>assertServerLoginForTasks()).toThrow('任务托管')
})
it('locks the complete workspace on Go disconnect and keeps existing local records',async()=>{
  await connect();completeDesktopLogin();logoutHost()
  expect(desktopLoginRequired()).toBe(true)
  expect(local.getItem('qihuo_auth_user')).toContain('old-local-profile')
})
it('does not restore a persisted Go bearer into a new native process',()=>{
  session.setItem('cyclepilot_go_host_session',JSON.stringify({mode:'server',origin:'https://host.example',token:'fixture-old-run',ownerID:'verified-owner',expiresAt:new Date(Date.now()+300000).toISOString()}))
  initializeDesktopLoginSession('new-native-process',session)
  restoreHostSession()
  expect(hostSession()).toBeNull()
  expect(desktopLoginRequired()).toBe(true)
})
it('opens a local-only workspace after explicit standalone center verification',()=>{
  enterStandalone({scope:'taskhost:standalone:verified-center',centerUserID:'verified-center'})
  expect(desktopLoginRequired()).toBe(false)
  expect(desktopSessionLocalOnly()).toBe(true)
  expect(()=>assertServerLoginForTasks()).toThrow()
})
it('a legacy API 401 cannot refresh, erase or redirect a valid Go session',async()=>{
  await connect()
  local.setItem('access_token','fixture-cached-legacy-token')
  local.setItem('refresh_token','fixture-cached-refresh')
  vi.stubGlobal('window',{location:{href:'/market'}})
  vi.mocked(fetch).mockReset().mockResolvedValue(new Response(JSON.stringify({detail:'legacy expired'}),{status:401}))
  const {getMeApi}=await import('./api')
  await expect(getMeApi()).rejects.toMatchObject({code:'LEGACY_AUTH_REQUIRED'})
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(window.location.href).toBe('/market')
  expect(local.getItem('access_token')).toBe('fixture-cached-legacy-token')
  expect(hostSession()).toMatchObject({ownerID:'verified-owner'})
})
it('keeps Go exchange configuration local despite a saved old server-account setting',async()=>{
  local.setItem('atd_account_transport','server')
  await connect()
  expect(serverAccountMode()).toBe(false)
  expect(local.getItem('atd_account_transport')).toBe('server')
})
