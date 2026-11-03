// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const f = vi.hoisted(() => ({ login: vi.fn(), session: null as unknown, navigate: vi.fn(), read: vi.fn(), save: vi.fn(), clear: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: () => f.navigate }))
vi.mock('@/lib/taskhost-client', () => ({ loginHost: f.login, hostSession: () => f.session, normalizeHost: (raw: string) => new URL(raw).origin }))
vi.mock('@/lib/host-login-key', () => ({ hostKeyStorageSupported: () => true, readSavedHostKey: f.read, saveHostKey: f.save, clearSavedHostKey: f.clear }))
vi.mock('@/lib/taskhost-local-profile', () => ({ selectedLocalHostProfile: () => null }))
vi.mock('@/lib/taskhost-workspace-profile', () => ({ activateHostWorkspace: vi.fn(async () => {}) }))
vi.mock('@/lib/taskhost-standalone', () => ({ loginStandalone: vi.fn() }))
vi.mock('@/components/common/brand-logo', () => ({ BrandLogo: () => null }))
import Connection from './connection-page'
let root: Root, container: HTMLDivElement
const oldKey = 'thk_' + 'a'.repeat(43), newKey = 'thk_' + 'b'.repeat(43)
async function input(element: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks(); localStorage.clear(); localStorage.setItem('cyclepilot_host_address', 'https://fixture.example')
  f.read.mockResolvedValue(oldKey); f.save.mockResolvedValue(null); f.clear.mockResolvedValue(null)
  f.login.mockImplementation(async (origin: string) => { f.session = { mode: 'server', origin, ownerID: 'fixture' }; return f.session })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root.render(<Connection />) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const field = () => container.querySelector<HTMLInputElement>('input[aria-label="后台签发的登录密钥"]')!
async function saved() { await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300))});expect(field().value).toBe(oldKey) }
it('restores a saved key as masked input and supports explicit viewing', async () => {
  await saved()
  expect(field().type).toBe('password')
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === '显示密钥')!.click() })
  expect(field().type).toBe('text')
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === '隐藏密钥')!.click() })
  expect(field().type).toBe('password')
})
it('replaces the old saved key only after a successful new handshake', async () => {
  await saved()
  await input(field(), newKey)
  f.login.mockRejectedValueOnce(Object.assign(new Error('fixture rejected'),{status:401}))
  await act(async () => container.querySelector('form')!.requestSubmit())
  expect(f.save).not.toHaveBeenCalled(); expect(f.clear).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled()
  expect(container.textContent).toContain('请输入新密钥')
  await act(async () => container.querySelector('form')!.requestSubmit())
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledExactlyOnceWith('https://fixture.example', newKey))
  expect(f.navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
  expect(Object.values(localStorage).join(' ')).not.toContain(newKey)
  expect(Object.values(localStorage).join(' ')).not.toContain(oldKey)
})
it('does not overwrite a manually entered key when an earlier saved-key lookup finishes', async () => {
  let resolve!: (key: string) => void
  f.read.mockImplementation(() => new Promise(r => { resolve = r }))
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  await input(field(), newKey)
  await act(async () => resolve(oldKey))
  expect(field().value).toBe(newKey)
})
it('clears the key on server-address changes and ignores the previous server response', async () => {
  let resolve!: (key: string) => void
  f.read.mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValueOnce(null)
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  const address = container.querySelector<HTMLInputElement>('input[autocomplete="url"]')!
  await input(address, 'https://another.example')
  await act(async () => resolve(oldKey))
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledWith('https://another.example'))
  expect(field().value).toBe('')
})
it('can forget the saved key without logging in or touching another server', async () => {
  await saved()
  await act(async()=>{[...container.querySelectorAll('button')].find(b=>b.textContent==='忘记已保存密钥')!.click()})
  expect(f.clear).toHaveBeenCalledExactlyOnceWith('https://fixture.example')
  expect(field().value).toBe('');expect(f.login).not.toHaveBeenCalled()
})
it('removes the remembered key after a successful login when saving is unchecked', async () => {
  await saved()
  await act(async()=>container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async()=>container.querySelector('form')!.requestSubmit())
  expect(f.save).not.toHaveBeenCalled();expect(f.clear).toHaveBeenCalledExactlyOnceWith('https://fixture.example')
})
