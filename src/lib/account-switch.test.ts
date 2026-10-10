import { afterEach,beforeEach,expect,it,vi } from "vitest"
const mocks=vi.hoisted(()=>({stop:vi.fn(),validate:vi.fn(),remember:vi.fn(),state:{user:{id:"a"},accessToken:"access-a",login:vi.fn()},server:"server-a"}))
vi.mock("@/stores/auth",()=>({useAuthStore:{getState:()=>mocks.state}}))
vi.mock("./realtime-factor/runtime",()=>({stopAllRealtime:mocks.stop}))
vi.mock("./account-sessions",()=>({validateAccount:mocks.validate}))
vi.mock("./account-profiles",()=>({accountServer:()=>mocks.server,rememberAccount:mocks.remember}))
import { switchAccount } from "./account-switch"
import type { AccountSession } from "./account-profiles"
const target={user:{id:"b",username:"B"},accessToken:"access-b",refreshToken:"refresh-b"} as AccountSession
beforeEach(()=>{
  vi.clearAllMocks();mocks.state.user={id:"a"};mocks.server="server-a"
  mocks.validate.mockResolvedValue(target);mocks.stop.mockResolvedValue(undefined)
  vi.stubGlobal("localStorage",{getItem:()=>"refresh-a"});vi.stubGlobal("window",{location:{replace:vi.fn()}})
})
afterEach(()=>vi.unstubAllGlobals())
it("stops local execution with the old identity before replacing credentials and reloading",async()=>{
  mocks.stop.mockImplementation(async()=>{expect(mocks.state.user.id).toBe("a");expect(mocks.state.login).not.toHaveBeenCalled()})
  await switchAccount(target)
  expect(mocks.state.login).toHaveBeenCalledWith(target.user,"access-b","refresh-b")
  expect(window.location.replace).toHaveBeenCalledWith("/dashboard")
  expect(mocks.remember).toHaveBeenCalledWith(expect.objectContaining({user:{id:"a"},refreshToken:"refresh-a"}))
})
it("keeps current execution and identity on a failed target login",async()=>{
  mocks.validate.mockRejectedValueOnce(new Error("expired"))
  await expect(switchAccount(target)).rejects.toThrow("expired")
  expect(mocks.stop).not.toHaveBeenCalled();expect(mocks.state.login).not.toHaveBeenCalled()
})
it("rejects a concurrent account/server change before touching execution",async()=>{
  mocks.validate.mockImplementationOnce(async()=>{mocks.server="server-b";return target})
  await expect(switchAccount(target)).rejects.toThrow("会话已变化")
  expect(mocks.stop).not.toHaveBeenCalled();expect(mocks.state.login).not.toHaveBeenCalled()
})
