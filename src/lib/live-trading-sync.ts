import type { MarketWebSocket } from '@/lib/websocket'
import { subscribeSnippetPrivate } from './snippet-private-ws'
import { isServerMode } from './desktop-routing'
import { useAuthStore } from '@/stores/auth'
import { usePaperTradingStore } from '@/stores/paper-trading'
import { useAITradingStore } from '@/stores/ai-trading'
import { getStoredVenue } from '@/lib/live-api'

export function hasFreshLiveSync(): boolean {
  const state = usePaperTradingStore.getState()
  return useAuthStore.getState().user?.trading_mode === 'live' && getStoredVenue() === 'okx'
    && state.liveSyncConnected && Date.now() - state.liveSyncAt < 35_000
}

/** Backend events carry invalidations, never unvalidated exchange positions. */
export function subscribeLiveTradingSync(ws: Pick<MarketWebSocket, 'onMessage' | 'onOpen' | 'onStateChange'>, isCurrent: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<'account' | 'positions' | 'orders'>()
  const queue = (sections: Array<'account' | 'positions' | 'orders'> = ['account', 'positions', 'orders']) => {
    sections.forEach(section => pending.add(section))
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (!isCurrent()) return
      const sections = [...pending];pending.clear()
      void usePaperTradingStore.getState().refresh({ afterCurrent: true, sections })
      if (sections.includes('positions') || sections.includes('orders')) {
        void useAITradingStore.getState().loadTasks({ silent: true })
        void useAITradingStore.getState().loadProfitBars({ silent: true })
      }
    }, 250)
  }
  const messageHandler: Parameters<MarketWebSocket['onMessage']>[0] = message => {
    if (!isCurrent() || message.type !== 'live_account_tick' || !message.data || typeof message.data !== 'object') return
    const data = message.data as Record<string, unknown>
    if (data.trading_mode !== 'live' || data.venue !== getStoredVenue()) return
    const previous = usePaperTradingStore.getState().liveSyncConnected
    const connected = data.connected === true && data.business_connected === true
    usePaperTradingStore.setState({ liveSyncConnected: connected, liveSyncAt: Date.now() })
    if (Array.isArray(data.channels)) {
      const sections = data.channels.filter((c): c is 'account' | 'positions' | 'orders' => ['account', 'positions', 'orders'].includes(c))
      if (sections.length) queue(sections)
    }
    if (previous && !connected) queue()
  }
  const offMessage = ws.onMessage(message => { if (isServerMode()) messageHandler(message) })
  const offSnippet = subscribeSnippetPrivate(messageHandler)
  const offOpen = ws.onOpen(() => {
    if (!isCurrent()) return
    usePaperTradingStore.setState({ liveSyncConnected: false, liveSyncAt: 0 })
    queue()
  })
  const offState = ws.onStateChange(state => {
    if (isCurrent() && state !== 'connected') usePaperTradingStore.setState({ liveSyncConnected: false, liveSyncAt: 0 })
  })
  return () => { offMessage();offSnippet();offOpen();offState();if (timer !== undefined) clearTimeout(timer) }
}
