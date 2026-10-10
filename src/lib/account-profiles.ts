import type { User } from "@/types"
export interface AccountSession { user: User; accessToken: string; refreshToken: string }
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">
const KEY = "atd_account_profiles"
export const MAX_ACCOUNTS = 5
export function accountServer(): string {
  return (localStorage.getItem("atd_desktop_server") || window.__QH_API_BASE__ || window.location.origin).replace(/\/+$/, "")
}
function readAll(storage: Storage): Record<string, AccountSession[]> {
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, AccountSession[]> : {}
  } catch { return {} }
}
export function loadAccounts(server = accountServer(), storage: Storage = localStorage): AccountSession[] {
  const rows: unknown = readAll(storage)[server]
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  return rows.filter((r): r is AccountSession => {
    if (!r?.user || typeof r.user.id !== "string" || !r.user.id || typeof r.user.username !== "string" || typeof r.accessToken !== "string" || typeof r.refreshToken !== "string" || seen.has(r.user.id)) return false
    seen.add(r.user.id); return true
  }).slice(0, MAX_ACCOUNTS)
}
export function rememberAccount(session: AccountSession, server = accountServer(), storage: Storage = localStorage): AccountSession[] {
  const all = readAll(storage), rows = loadAccounts(server,storage)
  const exists = rows.some(r => r.user.id === session.user.id)
  if (!exists && rows.length >= MAX_ACCOUNTS) throw new Error("最多添加 5 个用户，请先移除一个已添加用户")
  const next = exists ? rows.map(r => r.user.id === session.user.id ? session : r) : [...rows,session]
  all[server] = next
  storage.setItem(KEY,JSON.stringify(all))
  return next
}
export function forgetAccount(id: string, server = accountServer(), storage: Storage = localStorage): AccountSession[] {
  const all = readAll(storage), rows = loadAccounts(server,storage).filter(r=>r.user.id!==id)
  all[server] = rows; storage.setItem(KEY,JSON.stringify(all)); return rows
}
