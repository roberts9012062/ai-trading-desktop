import { afterEach,expect,it,vi } from "vitest"
import { getMeApi,tryRefreshToken } from "./api"
vi.mock("@/stores/auth",()=>({useAuthStore:{getState:()=>({setAccessToken:vi.fn()})}}))
afterEach(()=>vi.unstubAllGlobals())
it("never writes an old refresh response into a switched account",async()=>{
  const storage=new Map([["access_token","access-a"],["refresh_token","refresh-a"]])
  vi.stubGlobal("localStorage",{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)})
  let finish!:(r:Response)=>void
  vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve})))
  const pending=tryRefreshToken()
  storage.set("access_token","access-b");storage.set("refresh_token","refresh-b")
  finish(new Response(JSON.stringify({access_token:"new-a",refresh_token:"new-refresh-a"})))
  expect(await pending).toBe(false)
  expect(storage.get("access_token")).toBe("access-b")
  expect(storage.get("refresh_token")).toBe("refresh-b")
})
it("discards an old account's retried response after the identity changes",async()=>{
  const storage=new Map([["access_token","access-a"],["refresh_token","refresh-a"],["qihuo_auth_user",JSON.stringify({id:"a",trading_mode:"live"})]])
  vi.stubGlobal("window",{})
  vi.stubGlobal("localStorage",{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)})
  let finish!:(r:Response)=>void
  const fetcher=vi.fn()
    .mockResolvedValueOnce(new Response("{}",{status:401}))
    .mockResolvedValueOnce(new Response(JSON.stringify({access_token:"new-a",refresh_token:"new-refresh-a"})))
    .mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve}))
  vi.stubGlobal("fetch",fetcher)
  const pending=getMeApi()
  const rejected=expect(pending).rejects.toThrow("会话已切换")
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3))
  storage.set("access_token","access-b");storage.set("refresh_token","refresh-b");storage.set("qihuo_auth_user",JSON.stringify({id:"b",trading_mode:"live"}))
  finish(new Response(JSON.stringify({id:"a",username:"A"})))
  await rejected
  expect(storage.get("access_token")).toBe("access-b")
})

it.each([503,429])('retains established tokens when refresh is unavailable (%s)',async(status)=>{
  const storage=new Map([["access_token","access-a"],["refresh_token","refresh-a"],["qihuo_auth_user",JSON.stringify({id:"a",trading_mode:"live"})]])
  vi.stubGlobal("window",{location:{href:'/dashboard'}})
  vi.stubGlobal("localStorage",{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)})
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(new Response('{}',{status})))
  await expect(getMeApi()).rejects.toMatchObject({status})
  expect(storage.get('access_token')).toBe('access-a')
  expect(storage.get('refresh_token')).toBe('refresh-a')
  expect(window.location.href).toBe('/dashboard')
})

it('retains established tokens if refresh loses its connection',async()=>{
  const storage=new Map([["access_token","access-a"],["refresh_token","refresh-a"],["qihuo_auth_user",JSON.stringify({id:"a",trading_mode:"live"})]])
  vi.stubGlobal("window",{location:{href:'/dashboard'}})
  vi.stubGlobal("localStorage",{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)})
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockRejectedValueOnce(new TypeError('Failed to fetch')))
  await expect(getMeApi()).rejects.toMatchObject({status:503})
  expect(storage.get('access_token')).toBe('access-a')
})

it('reports an explicit invalid refresh as authentication failure',async()=>{
  const storage=new Map([["access_token","access-a"],["refresh_token","refresh-a"],["qihuo_auth_user",JSON.stringify({id:"a",trading_mode:"live"})]])
  vi.stubGlobal("window",{location:{href:'/dashboard'}})
  vi.stubGlobal("localStorage",{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)})
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(new Response('{}',{status:401})))
  await expect(getMeApi()).rejects.toMatchObject({status:401})
  expect(storage.has('access_token')).toBe(false)
})
