import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ collection: true, symbols: vi.fn(), spec: vi.fn(), legacy: vi.fn() }))
vi.mock('@/lib/collection-config', () => ({ collectionMode: () => fixture.collection }))
vi.mock('@/lib/collection-api', () => ({ collectionSymbols: fixture.symbols, collectionSpec: fixture.spec }))
vi.mock('@/lib/paper-api', () => ({ getProductSpecs: fixture.legacy }))
vi.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({ accessToken: 'fixture' }) } }))

beforeEach(() => { vi.resetModules(); fixture.collection = true; fixture.symbols.mockReset(); fixture.spec.mockReset(); fixture.legacy.mockReset(); vi.stubGlobal('window', {}) })
afterEach(() => vi.unstubAllGlobals())

it('loads chart metadata from the collection catalog while the business server is unavailable', async () => {
  fixture.symbols.mockResolvedValue([{ symbol: 'BTC-USDT-SWAP', tick_size: '0.1' }])
  fixture.legacy.mockRejectedValue(new Error('business server offline'))
  const { useContractSpecStore } = await import('./contract-spec')
  await useContractSpecStore.getState().load()
  expect(fixture.legacy).not.toHaveBeenCalled()
  expect(fixture.symbols).toHaveBeenCalledOnce()
  expect(useContractSpecStore.getState().loaded).toBe(true)
})

it('uses catalog tick size consistently for chart spec, price step and precision', async () => {
  fixture.spec.mockReturnValue({ symbol: 'PEPE-USDT-SWAP', tick_size: '0.0000001000' })
  const { useContractSpecStore } = await import('./contract-spec')
  const store = useContractSpecStore.getState()
  expect(store.getSpec('pepeusdt')).toEqual({ tick_size: 0.0000001, decimal_places: 7 })
  expect(store.getTickSize('pepeusdt')).toBe(0.0000001)
  expect(store.getDecimalPlaces('pepeusdt')).toBe(7)
})

it('does not reuse old server metadata when the collection catalog has no valid entry', async () => {
  fixture.spec.mockReturnValue(undefined)
  const { useContractSpecStore } = await import('./contract-spec')
  useContractSpecStore.setState({ specs: [{ code: 'BTC', tick_size: 100, decimal_places: 0 } as never] })
  expect(useContractSpecStore.getState().getSpec('btcusdt')).toBeNull()
  expect(useContractSpecStore.getState().getTickSize('btcusdt')).toBe(1)
})

it('preserves legacy chart metadata outside collection mode', async () => {
  fixture.collection = false
  fixture.legacy.mockResolvedValue({ items: [{ code: 'BTC', tick_size: 0.5, decimal_places: 1 }] })
  const { useContractSpecStore } = await import('./contract-spec')
  await useContractSpecStore.getState().load()
  expect(useContractSpecStore.getState().getSpec('btcusdt')).toMatchObject({ tick_size: 0.5, decimal_places: 1 })
  expect(fixture.symbols).not.toHaveBeenCalled()
})

it.each(['0', '-0.1', 'NaN', ''])('rejects invalid catalog price steps %s', async tick_size => {
  fixture.spec.mockReturnValue({ tick_size })
  const { useContractSpecStore } = await import('./contract-spec')
  expect(useContractSpecStore.getState().getSpec('btcusdt')).toBeNull()
})

it('retains precision for scientific notation in catalog metadata', async () => {
  fixture.spec.mockReturnValue({ tick_size: '1.20e-5' })
  const { useContractSpecStore } = await import('./contract-spec')
  expect(useContractSpecStore.getState().getSpec('btcusdt')).toEqual({ tick_size: 0.000012, decimal_places: 6 })
})
