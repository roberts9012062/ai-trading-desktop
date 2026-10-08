'use client'
import { useEffect } from 'react'
import { getMarketWebSocket } from '@/lib/websocket'
import { hasFreshLiveSync, subscribeLiveTradingSync } from '@/lib/live-trading-sync'
import { useAuthStore } from '@/stores/auth'
import { usePaperTradingStore } from '@/stores/paper-trading'

export function LiveTradingRuntime(): null {
  const user = useAuthStore(s => s.user)
  const venue = usePaperTradingStore(s => s.venue)
  useEffect(() => {
    if (!user?.id || user.trading_mode !== 'live') return
    const identity = user.id
    const isCurrent = () => {
      const current = useAuthStore.getState().user
      return current?.id === identity && current.trading_mode === 'live'
    }
    const off = subscribeLiveTradingSync(getMarketWebSocket(), isCurrent)
    void usePaperTradingStore.getState().refresh()
    // A low-rate audit also supports older servers and lost local events.
    const timer = setInterval(() => {
      if (!isCurrent()) return
      const state = usePaperTradingStore.getState()
      if (!hasFreshLiveSync() || Date.now()-state.lastRefreshAt >= 30_000) void state.refresh()
    }, 10_000)
    return () => { off();clearInterval(timer) }
  }, [user?.id, user?.trading_mode, venue])
  return null
}
