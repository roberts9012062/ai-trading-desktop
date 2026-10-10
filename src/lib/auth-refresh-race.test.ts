import { afterEach,expect,it,vi } from "vitest"
import { getMeApi,tryRefreshToken } from "./api"
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
