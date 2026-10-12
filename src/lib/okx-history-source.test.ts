import {afterEach,beforeEach,expect,it,vi} from "vitest"
beforeEach(()=>vi.resetModules())
afterEach(()=>vi.unstubAllGlobals())
it("defaults to automatic and persists manual source selection with subscriber notifications",async()=>{
  const values=new Map<string,string>()
  vi.stubGlobal("localStorage",{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)})
  const s=await import("./okx-history-source"),notify=vi.fn(),unsubscribe=s.subscribeOkxHistorySource(notify)
  expect(s.getOkxHistorySource()).toBe("auto")
  s.setOkxHistorySource("rest");expect(s.getOkxHistorySource()).toBe("rest")
  expect(values.get(s.OKX_HISTORY_SOURCE_KEY)).toBe("rest");expect(notify).toHaveBeenCalledOnce()
  unsubscribe();s.setOkxHistorySource("archive");expect(notify).toHaveBeenCalledOnce()
  vi.resetModules();expect((await import("./okx-history-source")).getOkxHistorySource()).toBe("archive")
})
it("still supports an in-session source when local storage is disabled",async()=>{
  vi.stubGlobal("localStorage",{getItem:()=>{throw new Error("disabled")},setItem:()=>{throw new Error("disabled")}})
  const s=await import("./okx-history-source")
  expect(s.getOkxHistorySource()).toBe("auto");s.setOkxHistorySource("rest");expect(s.getOkxHistorySource()).toBe("rest")
})
