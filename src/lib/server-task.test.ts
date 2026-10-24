import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServerTask } from './server-task'
import { initializeDesktopLoginSession, completeDesktopLogin } from './desktop-login-session'

let token = 'server-session', user = 'user-a', server = 'https://server.example'
beforeEach(() => {
  initializeDesktopLoginSession('test-server'); completeDesktopLogin()
  token = 'server-session'; user = 'user-a'; server = 'https://server.example'
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'access_token' ? token : key === 'qihuo_auth_user' ? JSON.stringify({ id: user }) : key === 'atd_desktop_server' ? server : null })
})
afterEach(() => vi.unstubAllGlobals())

it('requires a server login even if a cached user exists', async () => {
  token = ''
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'must-not-create'}))); vi.stubGlobal('fetch', fetch)
  await expect(createServerTask('', '/api/ai-trading/tasks', {})).rejects.toThrow('服务器登录')
  expect(fetch).not.toHaveBeenCalled()
})
it('does not register new tasks from a manually continued local-only session', async () => {
  completeDesktopLogin('local')
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'must-not-create'}))); vi.stubGlobal('fetch', fetch)
  await expect(createServerTask('', '/api/ai-trading/tasks', {})).rejects.toThrow('服务器登录')
  expect(fetch).not.toHaveBeenCalled()
})
it('creates only through the authenticated server endpoint', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'registered-task' }), { status: 201 }))
  vi.stubGlobal('fetch', fetch)
  await expect(createServerTask('https://server.example', '/api/ai-trading/tasks', { name: 'task' })).resolves.toEqual({ id: 'registered-task' })
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe('https://server.example/api/ai-trading/tasks')
  const init = fetch.mock.calls[0][1]
  expect(init.method).toBe('POST'); expect(init.cache).toBe('no-store')
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer server-session')
})
it('does not create a local task or retry when the server disconnects', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('network disconnected')); vi.stubGlobal('fetch', fetch)
  await expect(createServerTask('', '/api/ai-trading/tasks', {})).rejects.toThrow('未确认')
  expect(fetch).toHaveBeenCalledOnce()
})
it.each([401, 403, 503])('rejects a server failure (%i) rather than treating cache as registration', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: status === 403 ? '任务配额不足' : 'unavailable' }), { status })))
  await expect(createServerTask('', '/api/shortline/tasks', {})).rejects.toThrow(status === 401 ? '服务器登录' : status === 403 ? '任务配额不足' : '服务器暂不可用')
})
it('discards a task response after switching the account or server', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { user = 'user-b'; return new Response(JSON.stringify({ id: 'old-task' }), { status: 201 }) }))
  await expect(createServerTask('', '/api/ai-trading/tasks', {})).rejects.toThrow('已切换')
})
it('requires a real server task identifier in a successful response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 })))
  await expect(createServerTask('', '/api/ai-trading/tasks', {})).rejects.toThrow('任务编号')
})
