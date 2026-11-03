import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAITradingStore } from './ai-trading'
import { useAuthStore } from './auth'
import { initializeDesktopLoginSession, completeDesktopLogin } from '@/lib/desktop-login-session'
import * as api from '@/lib/ai-trading-api'
import type { User } from '@/types'
vi.mock('@/lib/ai-trading-api', () => ({ listAITradingTasks: vi.fn(), fetchEquitySeries: vi.fn(), fetchProfitBars: vi.fn(), listAITradingDecisions: vi.fn(), listAITradingTrades: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  initializeDesktopLoginSession('transport-test', localStorage); completeDesktopLogin('server', 'legacy')
  useAuthStore.setState({ user: { id: 'same-profile', trading_mode: 'live' } as User })
})
afterEach(() => vi.unstubAllGlobals())
it('blocks all legacy reads from shared callbacks in Go and standalone sessions', async () => {
  useAITradingStore.setState({ error: '加载失败', selectedTaskId: 'old-id' })
  completeDesktopLogin('server', 'taskhost')
  expect(useAITradingStore.getState().error).toBeNull()
  await useAITradingStore.getState().loadTasks()
  await useAITradingStore.getState().loadEquity()
  await useAITradingStore.getState().loadProfitBars()
  await useAITradingStore.getState().refreshDetail()
  expect(api.listAITradingTasks).not.toHaveBeenCalled()
  expect(api.fetchProfitBars).not.toHaveBeenCalled()
  expect(api.listAITradingDecisions).not.toHaveBeenCalled()
  expect(useAITradingStore.getState()).toMatchObject({ loading: false, profitLoading: false, error: null })
})
it('ignores a failed legacy request that completes after changing transport on the same profile', async () => {
  let reject!: (error: unknown) => void
  vi.mocked(api.listAITradingTasks).mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
  const pending = useAITradingStore.getState().loadTasks()
  completeDesktopLogin('local', 'taskhost')
  reject('old server failed'); await pending
  expect(useAITradingStore.getState()).toMatchObject({ loading: false, error: null, tasks: [] })
})
it('clears old errors and detail selections when changing local profile', () => {
  useAITradingStore.setState({ error: 'old profile error', selectedTaskId: 'old-id', detailLoading: true })
  useAuthStore.setState({ user: { id: 'new-profile', trading_mode: 'live' } as User })
  expect(useAITradingStore.getState()).toMatchObject({ error: null, selectedTaskId: null, detailLoading: false })
})
