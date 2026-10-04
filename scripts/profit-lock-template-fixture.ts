/** Mock persistence solely for isolated UI acceptance. No server fallback. */
import { useAuthStore } from "@/stores/auth"
import type { ProfitLockTemplate } from "@/lib/profit-lock-templates"
export function templateFixture(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
  const url = new URL(String(input), location.href)
  const prefix = "/api/profit-lock-templates"
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return
  if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("隔离验收端口错误")
  const key = "fixture-profit-lock-templates-" + (useAuthStore.getState().user?.id ?? "")
  let items: ProfitLockTemplate[] = JSON.parse(localStorage.getItem(key) ?? "[]")
  const id = url.pathname.slice(prefix.length + 1)
  const method = init?.method ?? "GET"
  if (method === "GET") return Response.json(items)
  if (method === "DELETE") items = items.filter(t => t.id !== id)
  else {
    const body = JSON.parse(String(init?.body))
    if (items.some(t => t.id !== id && t.name === body.name)) return Response.json({ detail: "同名锁利模板已存在，请换一个名称" }, { status: 409 })
    const row = { ...body, id: id || crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    items = [...items.filter(t => t.id !== row.id), row]
    localStorage.setItem(key, JSON.stringify(items))
    return Response.json(row)
  }
  localStorage.setItem(key, JSON.stringify(items))
  return Response.json({ deleted: true })
}
