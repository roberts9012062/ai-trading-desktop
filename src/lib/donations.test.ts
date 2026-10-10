import { expect,it } from "vitest"
import { emptyDonations,listedChains,type ListedDonation } from "./donations"
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
