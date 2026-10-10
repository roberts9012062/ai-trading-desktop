import { afterEach, expect,it,vi } from "vitest"
import { emptyDonations,getDonations,listedChains,type ListedDonation } from "./donations"
afterEach(() => vi.unstubAllGlobals())
it("loads public donation settings independently of the active user session",async()=>{
  const storage= { getItem: vi.fn(() => "expired-token") }
  vi.stubGlobal("localStorage",storage)
  const fetch=vi.fn().mockResolvedValue(Response.json({ enabled:true,channels:[] }))
  vi.stubGlobal("fetch",fetch)
  await expect(getDonations()).resolves.toEqual({enabled:true,channels:[]})
  expect(storage.getItem).not.toHaveBeenCalled()
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization")
  expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})
it("rejects a successful non-configuration response rather than treating it as disabled",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("<html>proxy error</html>")))
  await expect(getDonations()).rejects.toThrow("打赏配置响应无效")
})
it("distinguishes an explicit shutdown from a failed request",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({enabled:false,channels:[]})).mockRejectedValueOnce(new Error("offline"))
  vi.stubGlobal("fetch",fetch)
  await expect(getDonations()).resolves.toEqual({enabled:false,channels:[]})
  await expect(getDonations()).rejects.toThrow("offline")
})
it("uses stable chain identities and keeps only the server-listed choices",()=>{
  const c={kind:"crypto",chains:[{id:"tron",network:"Tron",address:"tron-address",currency:"USDT",qr_image:""}]} as ListedDonation
  expect(listedChains(c).map(c=>c.id)).toEqual(["tron"])
  expect(listedChains({...c,chains:[]})).toEqual([])
})
it("keeps a legacy server's payment details available as a single choice",()=>{
  const c={...emptyDonations().crypto,kind:"crypto",label:"虚拟币打赏",address:"old",network:"Ethereum"} as ListedDonation
  expect(listedChains(c)).toEqual([expect.objectContaining({id:"legacy",address:"old",network:"Ethereum"})])
  expect(listedChains()).toEqual([])
})
