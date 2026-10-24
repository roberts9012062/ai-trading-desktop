import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountSession } from './account-profiles'
const fixture = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('./account-sessions', () => ({ sessionForTokens: fixture.probe }))
import { continueKnownDesktopSession } from './desktop-session-continuation'
const saved = { user: { id:'known', username:'known', role:'user', trading_mode:'live', status:'active' }, accessToken:'cached-test-access', refreshToken:'cached-test-refresh' } as AccountSession
beforeEach(() => fixture.probe.mockReset())
afterEach(() => vi.restoreAllMocks())

it.each([undefined, 503, 429])('allows explicit native continuation during a transport outage (%s)', async status => {
  fixture.probe.mockRejectedValue(Object.assign(new Error('unavailable'), status ? { status } : {}))
  expect(await continueKnownDesktopSession(saved, true)).toBe(saved)
  expect(fixture.probe).toHaveBeenCalledOnce()
})
it.each([401,403,400,404])('never ignores a definitive server rejection (%s)', async status => {
  fixture.probe.mockRejectedValue(Object.assign(new Error('rejected'), { status }))
  await expect(continueKnownDesktopSession(saved, true)).rejects.toMatchObject({ status })
})
it('requires an established native identity and rejects cross-account server responses', async () => {
  await expect(continueKnownDesktopSession(saved, false)).rejects.toMatchObject({ status:401 })
  await expect(continueKnownDesktopSession({...saved, accessToken:''}, true)).rejects.toMatchObject({ status:401 })
  expect(fixture.probe).not.toHaveBeenCalled()
  fixture.probe.mockResolvedValue({...saved,user:{...saved.user,id:'other'}})
  await expect(continueKnownDesktopSession(saved, true)).rejects.toMatchObject({ status:403 })
})
it('validates the saved credentials explicitly when the server is reachable', async () => {
  fixture.probe.mockResolvedValue(saved)
  expect(await continueKnownDesktopSession(saved, true)).toBe(saved)
  expect(fixture.probe).toHaveBeenCalledWith(saved.accessToken, saved.refreshToken)
})
