import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initializeDesktopLoginSession, completeDesktopLogin } from './desktop-login-session'
import { request } from './ai-trading-api'

beforeEach(() => {
  initializeDesktopLoginSession('local-task-test'); completeDesktopLogin('local')
  vi.stubGlobal('localStorage', { getItem: () => 'cached-test-token' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'existing',status:'stopped'}))))
})
afterEach(() => { completeDesktopLogin('server'); vi.unstubAllGlobals() })
it.each(['start','run-once','realtime/start'])('requires server login for a new task execution action (%s)', async action => {
  await expect(request(`/api/ai-trading/tasks/existing/${action}`,{method:'POST'})).rejects.toThrow('服务器登录')
  expect(fetch).not.toHaveBeenCalled()
})
it('does not block stopping an existing task', async () => {
  expect(await request('/api/ai-trading/tasks/existing/stop',{method:'POST'})).toMatchObject({status:'stopped'})
  expect(fetch).toHaveBeenCalledOnce()
})
