export interface PublishedAnnouncement {
  id: string
  title: string
  content: string
  published: boolean
  published_at: string
}
const base = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("access_token")
  const response = await fetch(`${base}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(15000), headers: {
    "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
  } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "公告请求失败，请重试")
  return data as T
}
export const latestAnnouncement = () => call<{ item: PublishedAnnouncement | null }>("/api/announcements/latest")
export const listAnnouncements = async (admin = false) => (await call<{ items: PublishedAnnouncement[] }>(admin ? "/api/admin/announcements" : "/api/announcements")).items
export const publishAnnouncement = (title: string, content: string) => call<PublishedAnnouncement>("/api/admin/announcements", { method: "POST", body: JSON.stringify({ title, content }) })
export const withdrawAnnouncement = (id: string) => call<PublishedAnnouncement>(`/api/admin/announcements/${encodeURIComponent(id)}/withdraw`, { method: "POST" })

export function announcementScope(userId: string, server?: string): string {
  let endpoint = server || base || location.origin
  if (!server) { try { endpoint = localStorage.getItem("atd_desktop_server") || endpoint } catch { /* use configured origin */ } }
  return `announcement-dismissed:${JSON.stringify([endpoint.replace(/\/$/, ""), userId])}`
}
export function isAnnouncementDismissed(scope: string, id: string): boolean {
  try { return localStorage.getItem(scope) === id } catch { return false }
}
export function setAnnouncementDismissed(scope: string, id: string, checked: boolean): boolean {
  try {
    if (checked) localStorage.setItem(scope, id)
    else if (localStorage.getItem(scope) === id) localStorage.removeItem(scope)
    return true
  } catch { return false }
}
