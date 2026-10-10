import { beforeEach, expect, it } from "vitest"
import { loadAccounts, rememberAccount, forgetAccount } from "./account-profiles"
import type { User } from "@/types"
const memory = new Map<string,string>()
const storage = { getItem: (k:string) => memory.get(k) ?? null, setItem: (k:string,v:string) => { memory.set(k,v) }, removeItem: (k:string) => { memory.delete(k) } }
const session = (id:string) => ({ user: { id, username: `user${id}`, role:"user", trading_mode:"live" } as User, accessToken:`access-${id}`, refreshToken:`refresh-${id}` })
beforeEach(() => memory.clear())
it("keeps at most five users including current and updates an existing session", () => {
  for(let i=0;i<5;i++) rememberAccount(session(String(i)),"https://a.test",storage)
  expect(() => rememberAccount(session("5"),"https://a.test",storage)).toThrow("5")
  rememberAccount({...session("0"),accessToken:"renewed"},"https://a.test",storage)
  expect(loadAccounts("https://a.test",storage)).toHaveLength(5)
  expect(loadAccounts("https://a.test",storage).find(s=>s.user.id==="0")?.accessToken).toBe("renewed")
})
it("isolates credentials by server and can remove an inactive account", () => {
  rememberAccount(session("1"),"https://a.test",storage)
  expect(loadAccounts("https://b.test",storage)).toEqual([])
  forgetAccount("1","https://b.test",storage)
  expect(loadAccounts("https://a.test",storage)).toHaveLength(1)
  forgetAccount("1","https://a.test",storage)
  expect(loadAccounts("https://a.test",storage)).toEqual([])
})
it("recovers malformed storage without restoring arbitrary values", () => {
  storage.setItem("atd_account_profiles",JSON.stringify({"https://a.test":[{},session("1"),session("1")]}))
  expect(loadAccounts("https://a.test",storage).map(s=>s.user.id)).toEqual(["1"])
})
