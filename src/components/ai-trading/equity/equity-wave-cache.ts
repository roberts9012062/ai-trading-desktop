import { MAX_WAVE_SAMPLES, type EquityTraces } from "./equity-wave-data"

const KEY = "ai-position-waves-v1"
let lastSaved = 0
let lastIds = ""
export function readWaveCache(owner: string): EquityTraces {
  if (typeof localStorage === "undefined") return {}
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) ?? "null")
    if (cached?.owner !== owner || !cached.traces || typeof cached.traces !== "object") return {}
    const traces: EquityTraces = {}
    for (const [id, value] of Object.entries(cached.traces)) {
      const trace = value as EquityTraces[string]
      if (!trace || typeof trace.positionKey !== "string" || !Array.isArray(trace.samples) || trace.samples.length > MAX_WAVE_SAMPLES + 2) continue
      // Without an opening identity a restart cannot distinguish the previous trade from a reopening.
      if (!Number.isFinite(trace.openedAt)) continue
      if (!trace.samples.every((p, i) => Number.isFinite(p?.time) && Number.isFinite(p?.value) && (i === 0 || p.time > trace.samples[i - 1].time))) continue
      traces[id] = trace
    }
    return traces
  } catch { return {} }
}

export function saveWaveCache(owner: string, traces: EquityTraces, now: number): void {
  if (typeof localStorage === "undefined") return
  const ids = JSON.stringify([owner, Object.entries(traces).map(([id, t]) => [id, t.positionKey])])
  // Full closes/reopens are persisted immediately; regular samples at most once per 5 seconds.
  if (ids === lastIds && now - lastSaved < 5000) return
  try { localStorage.setItem(KEY, JSON.stringify({ owner, traces })); lastSaved = now; lastIds = ids } catch { /* Quota/private-mode failures cannot affect trading. */ }
}

export function clearWaveCache(): void {
  lastSaved = 0; lastIds = ""
  try { if (typeof localStorage !== "undefined") localStorage.removeItem(KEY) } catch { /* ignore */ }
}
