import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("./api",()=>({normalizeUser:(raw:unknown)=>raw}))
import { signInAccount, validateAccount } from "./account-sessions"
const saved={user:{id:"b",username:"B",trading_mode:"live" as const,role:"user" as const,phone:null,email:null,avatar:null},accessToken:"expired-b",refreshToken:"refresh-b"}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status})
beforeEach(()=>vi.stubGlobal("fetch",vi.fn()))
afterEach(()=>vi.unstubAllGlobals())
it("validates added credentials without using the current token",async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(json({access_token:"access-b",refresh_token:"refresh-b"})).mockResolvedValueOnce(json(saved.user))
  const result=await signInAccount("B","test-only")
  expect(result.user.id).toBe("b")
  expect(fetch).toHaveBeenNthCalledWith(2,expect.stringContaining("/api/auth/me"),expect.objectContaining({headers:{"Content-Type":"application/json",Authorization:"Bearer access-b"}}))
})
it("refreshes only the selected account and rejects a different identity",async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(json({},401)).mockResolvedValueOnce(json({access_token:"new-b",refresh_token:"new-refresh-b"})).mockResolvedValueOnce(json(saved.user))
  expect((await validateAccount(saved)).accessToken).toBe("new-b")
  expect(fetch).toHaveBeenNthCalledWith(2,expect.stringContaining("/api/auth/refresh"),expect.objectContaining({body:JSON.stringify({refresh_token:"refresh-b"})}))
  vi.mocked(fetch).mockResolvedValueOnce(json({...saved.user,id:"c"}))
  await expect(validateAccount(saved)).rejects.toThrow("不匹配")
})
it("wrong credentials or a frozen account never fall back to another token",async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(json({detail:"密码错误"},401))
  await expect(signInAccount("B","wrong")).rejects.toThrow("密码错误")
  expect(fetch).toHaveBeenCalledTimes(1)
  vi.mocked(fetch).mockResolvedValueOnce(json({detail:"冻结"},403))
  await expect(validateAccount(saved)).rejects.toThrow("冻结")
  expect(fetch).toHaveBeenCalledTimes(2)
})
