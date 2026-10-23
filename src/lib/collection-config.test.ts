import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('waits for the same native key load before concurrent startup requests proceed', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.stubGlobal('localStorage', { getItem: () => null })
  let finish!: (value: { configured: boolean }) => void
  fixture.invoke.mockImplementation((command: string) => command === 'collection_key'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ code: 200, data: { ready: true } }))
  const config = await import('./collection-config')
  const first = config.loadCollectionConfig()
  let settled = false
  const request = config.collectionRequest('/v1/my/permissions').then(value => { settled = true; return value }, error => { settled = true; throw error })
  // Attach a rejection handler immediately; the assertion still reports failure.
  void request.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(settled).toBe(false)
  finish({ configured: true })
  await expect(first).resolves.toMatchObject({ configured: true })
  await expect(request).resolves.toEqual({ ready: true })
})
