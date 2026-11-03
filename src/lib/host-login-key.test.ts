import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => native)
import { readSavedHostKey, saveHostKey, clearSavedHostKey } from './host-login-key'
const key = 'thk_' + 'a'.repeat(43)
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); native.invoke.mockResolvedValue(null) })
afterEach(() => vi.unstubAllGlobals())
it('uses only native secure storage, with a canonical server origin and no browser persistence', async () => {
  native.invoke.mockResolvedValueOnce(key)
  expect(await readSavedHostKey('https://fixture.example/')).toBe(key)
  await saveHostKey('https://fixture.example', key); await clearSavedHostKey('https://fixture.example')
  expect(native.invoke.mock.calls.map(c => c[1])).toEqual([{origin:'https://fixture.example',action:'read',key:null},{origin:'https://fixture.example',action:'save',key},{origin:'https://fixture.example',action:'clear',key:null}])
})
it('never persists a secret in browser-only mode or exposes native error contents', async () => {
  vi.stubGlobal('window', {})
  expect(await saveHostKey('https://fixture.example', key)).toBeNull(); expect(native.invoke).not.toHaveBeenCalled()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); native.invoke.mockRejectedValue(key)
  const error = await readSavedHostKey('https://fixture.example').catch(e => e)
  expect(error.message).not.toContain(key); expect(error.message).toContain('安全存储')
})
