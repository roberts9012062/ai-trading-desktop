import { beforeEach, describe, expect, it, vi } from 'vitest'

function storage() {
  const values = new Map<string, string>([['cached-market', 'keep-market'], ['task-records', 'keep-tasks']])
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

describe('desktop launch login confirmation', () => {
  beforeEach(() => vi.resetModules())

  it('requires login on a new native run despite a previous successful launch', async () => {
    const session = await import('./desktop-login-session'), saved = storage()
    session.initializeDesktopLoginSession('run-one', saved)
    expect(session.desktopLoginRequired()).toBe(true)
    session.completeDesktopLogin()
    expect(session.desktopLoginRequired()).toBe(false)
    vi.resetModules()
    const restarted = await import('./desktop-login-session')
    restarted.initializeDesktopLoginSession('run-two', saved)
    expect(restarted.desktopLoginRequired()).toBe(true)
    expect(saved.values.get('cached-market')).toBe('keep-market')
    expect(saved.values.get('task-records')).toBe('keep-tasks')
  })

  it('keeps an explicitly verified login across same-run renderer and account-switch reloads', async () => {
    const saved = storage(), first = await import('./desktop-login-session')
    first.initializeDesktopLoginSession('same-process', saved); first.completeDesktopLogin()
    vi.resetModules()
    const reloaded = await import('./desktop-login-session')
    reloaded.initializeDesktopLoginSession('same-process', saved)
    expect(reloaded.desktopLoginRequired()).toBe(false)
  })

  it('keeps manual local access restricted through renderer reloads until a server login succeeds', async () => {
    const saved = storage(), first = await import('./desktop-login-session')
    first.initializeDesktopLoginSession('same-process', saved); first.completeDesktopLogin('local')
    expect(first.desktopSessionLocalOnly()).toBe(true)
    vi.resetModules()
    const reloaded = await import('./desktop-login-session')
    reloaded.initializeDesktopLoginSession('same-process', saved)
    expect(reloaded.desktopLoginRequired()).toBe(false)
    expect(reloaded.desktopSessionLocalOnly()).toBe(true)
    reloaded.completeDesktopLogin('server')
    expect(reloaded.desktopSessionLocalOnly()).toBe(false)
  })

  it('locks again on explicit logout and keeps unrelated data', async () => {
    const saved = storage(), session = await import('./desktop-login-session')
    session.initializeDesktopLoginSession('run', saved); session.completeDesktopLogin(); session.requireDesktopLogin()
    expect(session.desktopLoginRequired()).toBe(true)
    session.initializeDesktopLoginSession('run', saved)
    expect(session.desktopLoginRequired()).toBe(true)
    expect(saved.values.get('task-records')).toBe('keep-tasks')
  })

  it('starts locked and never accepts a confirmation before launch initialization', async () => {
    const session = await import('./desktop-login-session')
    session.completeDesktopLogin()
    expect(session.desktopLoginRequired()).toBe(true)
  })

  it('blocks new task actions while the entry page is locked and never upgrades a locked local session', async () => {
    const session = await import('./desktop-login-session'), saved = storage()
    session.initializeDesktopLoginSession('locked-run', saved)
    expect(() => session.assertServerLoginForTasks()).toThrow('服务器登录')
    session.completeDesktopLogin('local'); session.requireDesktopLogin()
    expect(session.desktopSessionLocalOnly()).toBe(true)
    expect(() => session.assertServerLoginForTasks()).toThrow('服务器登录')
    session.completeDesktopLogin('server')
    expect(() => session.assertServerLoginForTasks()).not.toThrow()
  })

  it('keeps login usable when session storage is unavailable without persisting an unlock', async () => {
    const session = await import('./desktop-login-session')
    const broken = { getItem: () => { throw new Error('storage blocked') }, setItem: () => { throw new Error('storage blocked') }, removeItem: () => { throw new Error('storage blocked') } }
    session.initializeDesktopLoginSession('run', broken)
    expect(session.desktopLoginRequired()).toBe(true)
    session.completeDesktopLogin()
    expect(session.desktopLoginRequired()).toBe(false)
    session.initializeDesktopLoginSession('run', broken)
    expect(session.desktopLoginRequired()).toBe(true)
  })
})
