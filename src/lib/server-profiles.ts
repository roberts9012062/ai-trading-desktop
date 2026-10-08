export interface ServerProfile { id: string; name: string; base: string }
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">
const LIST_KEY = "atd_desktop_servers"
const SESSION_KEY = "atd_desktop_server_sessions"
const SESSION_FIELDS = ["access_token", "refresh_token", "qihuo_auth_user", "qihuo_login_remember", "qihuo_login_username", "qihuo_login_password"] as const
const defaults: ServerProfile[] = [
  { id: "public", name: "公网入口", base: "https://b.00n.top" },
  { id: "direct", name: "直连服务器", base: "http://64.83.17.130:8002" },
]

export function normalizeServerBase(raw: string): string {
  const text = raw.trim()
  if (!text) throw new Error("请填写服务器地址")
  const url = new URL(/^[a-z][\w+.-]*:/i.test(text) && !/^[\w.-]+:\d+(\/|$)/.test(text) ? text : `https://${text}`)
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("服务器地址须为 HTTP/HTTPS 地址，不能包含账号、密码或查询参数")
  }
  return url.href.replace(/\/+$/, "")
}

export function loadServers(storage: Storage = localStorage): ServerProfile[] {
  try {
    const saved = storage.getItem(LIST_KEY)
    if (saved !== null) {
      const list: unknown = JSON.parse(saved)
      if (Array.isArray(list)) return list.filter((s): s is ServerProfile => Boolean(s && typeof s.id === "string" && typeof s.name === "string" && typeof s.base === "string"))
        .map(s => ({ ...s, base: normalizeServerBase(s.base) }))
    }
  } catch { /* recover corrupt legacy storage */ }
  const list = defaults.map(s => ({ ...s }))
  const current = storage.getItem("atd_desktop_server")
  if (current) {
    try {
      const base = normalizeServerBase(current)
      if (!list.some(s => s.base === base)) list.push({ id: "migrated", name: "当前服务器", base })
    } catch { /* invalid override */ }
  }
  storage.setItem(LIST_KEY, JSON.stringify(list))
  return list
}

export function saveServer(list: ServerProfile[], profile: ServerProfile, storage: Storage = localStorage): ServerProfile[] {
  const item = { ...profile, name: profile.name.trim(), base: normalizeServerBase(profile.base) }
  if (!item.name) throw new Error("请填写服务器名称")
  if (list.some(s => s.id !== item.id && s.base === item.base)) throw new Error("该服务器地址已在列表中")
  const next = list.some(s => s.id === item.id) ? list.map(s => s.id === item.id ? item : s) : [...list, item]
  storage.setItem(LIST_KEY, JSON.stringify(next))
  return next
}

export function deleteServer(list: ServerProfile[], id: string, storage: Storage = localStorage): ServerProfile[] {
  const next = list.filter(s => s.id !== id)
  storage.setItem(LIST_KEY, JSON.stringify(next))
  return next
}

/** Reload the application after this transaction so imported API constants,
 * requests, sockets and every in-memory store belong to the selected server. */
export function selectServer(current: string, target: string, storage: Storage = localStorage): void {
  const base = normalizeServerBase(target)
  if (current === base) { storage.setItem("atd_desktop_server", base); return }
  let sessions: Record<string, Partial<Record<typeof SESSION_FIELDS[number], string>>> = {}
  try { sessions = JSON.parse(storage.getItem(SESSION_KEY) || "{}") } catch { /* legacy */ }
  sessions[current] = Object.fromEntries(SESSION_FIELDS.flatMap(k => {
    const value = storage.getItem(k)
    return value === null ? [] : [[k, value]]
  }))
  // Persist before changing credentials. A storage failure must not appear successful.
  storage.setItem(SESSION_KEY, JSON.stringify(sessions))
  for (const field of SESSION_FIELDS) {
    const value = sessions[base]?.[field]
    if (typeof value === "string") storage.setItem(field, value)
    else storage.removeItem(field)
  }
  storage.setItem("atd_desktop_server", base)
}
