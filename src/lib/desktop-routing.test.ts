import { afterEach, expect, it, vi } from 'vitest'
import { isServerMode, refreshDesktopRouting, stopDesktopRouting } from './desktop-routing'
afterEach(()=>{stopDesktopRouting();vi.unstubAllGlobals()})
it('keeps cold start safe and ignores an old policy response after logout',async()=>{
  let resolve!: (response:Response)=>void
  vi.stubGlobal('fetch',vi.fn().mockReturnValue(new Promise(r=>{resolve=r})))
  expect(isServerMode()).toBe(true)
  const request=refreshDesktopRouting();stopDesktopRouting()
  resolve(new Response(JSON.stringify({server_market_enabled:false})));await request
  expect(isServerMode()).toBe(true)
})
it('loads explicit false and preserves known policy during a network outage',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({server_market_enabled:false}))).mockRejectedValueOnce(new Error('offline'))
  vi.stubGlobal('fetch',fetch);await refreshDesktopRouting();expect(isServerMode()).toBe(false)
  await refreshDesktopRouting();expect(isServerMode()).toBe(false)
})
