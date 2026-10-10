/** Global administrator policy; server mode is the safe cold-start default. */
import { refreshSnippetPool, resetSnippetPool } from "./snippet-pool"
let serverMode = true
let known = false
let timer: ReturnType<typeof setInterval> | null = null
let flight: Promise<void> | null = null
let generation = 0
const listeners = new Set<(server: boolean) => void>()
export const isServerMode = () => serverMode
export function onDesktopRoutingChange(listener: (server: boolean) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener) }
}
export async function refreshDesktopRouting(): Promise<void> {
  if (flight) return flight
  const started = generation
  flight = (async () => {
    try {
      const base = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
      const response = await fetch(base + "/api/market/desktop-routing", { signal: AbortSignal.timeout(5000), cache: "no-store" })
      if (!response.ok) return
      const data = await response.json()
      if (started !== generation || typeof data.server_market_enabled !== "boolean") return
      const changed = !known || serverMode !== data.server_market_enabled
      known = true; serverMode = data.server_market_enabled
      if (!serverMode) await refreshSnippetPool()
      if (started === generation && changed) listeners.forEach(listener => listener(serverMode))
    } catch { /* Keep the last known global policy; cold start stays on server. */ }
  })().finally(() => { if (started === generation) flight = null })
  return flight
}
export async function ensureDesktopRouting(): Promise<void> {
  if (timer === null && typeof window !== "undefined") timer = setInterval(() => { void refreshDesktopRouting() }, 15000)
  if (!known) await refreshDesktopRouting()
  if (!serverMode) await refreshSnippetPool()
}
export function stopDesktopRouting(): void {
  if (timer !== null) clearInterval(timer)
  generation++; flight = null
  timer = null; known = false; serverMode = true
  resetSnippetPool()
  listeners.forEach(listener => listener(true))
}
