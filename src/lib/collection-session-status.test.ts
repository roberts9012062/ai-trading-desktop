import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./collection-config', () => ({ collectionMode: () => true }))
vi.mock('./collection-chart-cache', () => ({ collectionChartKlines: vi.fn() }))
vi.mock('./snippet-rest', () => ({ snippetQuotes: vi.fn(), snippetKlines: vi.fn(), withSnippetRead: vi.fn() }))
vi.mock('./local-records', () => ({ tryLocalRecordRequest: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it('uses the crypto continuous session without querying the business server calendar', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('business server offline'))
  vi.stubGlobal('fetch', fetch)
  const { getSessionStatusApi } = await import('./api')
  await expect(getSessionStatusApi('btcusdt')).resolves.toMatchObject({ symbol: 'btcusdt', product_code: 'BTC', is_open: true, profile: 'crypto_24x7' })
  expect(fetch).not.toHaveBeenCalled()
})

it('does not apply crypto hours to an invalid or non-crypto contract', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const { getSessionStatusApi } = await import('./api')
  await expect(getSessionStatusApi('rb2610')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})
