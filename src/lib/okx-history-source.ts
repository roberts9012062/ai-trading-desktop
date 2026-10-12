export type OkxHistorySource = "auto" | "archive" | "rest"
export const OKX_HISTORY_SOURCE_KEY = "qh_okx_history_download_source"
let memory: OkxHistorySource = "auto"
const listeners = new Set<() => void>()
export function getOkxHistorySource(): OkxHistorySource {
  try {
    const value = localStorage.getItem(OKX_HISTORY_SOURCE_KEY)
    if (value === "auto" || value === "archive" || value === "rest") return value
  } catch { /* The setting still works for this session without browser storage. */ }
  return memory
}
export function setOkxHistorySource(value: OkxHistorySource): void {
  memory = value
  try { localStorage.setItem(OKX_HISTORY_SOURCE_KEY, value) } catch { /* Session only. */ }
  listeners.forEach(fn => fn())
}
export function subscribeOkxHistorySource(fn: () => void): () => void {
  listeners.add(fn)
  if (typeof window !== "undefined") window.addEventListener("storage", fn)
  return () => {
    listeners.delete(fn)
    if (typeof window !== "undefined") window.removeEventListener("storage", fn)
  }
}
