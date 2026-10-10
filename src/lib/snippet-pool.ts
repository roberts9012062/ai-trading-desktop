/** Only the authenticated product server chooses trusted proxy origins. */
export type SnippetKind = "rest" | "public_ws" | "private_ws"
export type SnippetNode = { id: string; name: string; kind: SnippetKind; url: string }
const defaults: Record<SnippetKind, SnippetNode> = {
  rest: { id: "rest-default", name: "默认 REST", kind: "rest", url: "https://okx-rest-test.kins.eu.org" },
  public_ws: { id: "public-default", name: "默认公共 WS", kind: "public_ws", url: "wss://okx-ws-test.kins.eu.org" },
  private_ws: { id: "private-default", name: "默认私有 WS", kind: "private_ws", url: "wss://okx-private-ws.kins.eu.org" },
}
let nodes: Partial<Record<SnippetKind, SnippetNode>> = {}
let known = false
let identity = ""
let nextRefresh = 0
let generation = 0
let flight: Promise<void> | null = null
const excluded = new Map<string, number>()
const sampled = new Map<string, number>()
const listeners = new Set<() => void>()
const token = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("access_token") || ""
const base = () => (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

export function snippetNode(kind: SnippetKind): SnippetNode {
  const node = known ? nodes[kind] : defaults[kind]
  if (!node) throw new Error("暂无可用代理线路，使用服务器兜底")
  return node
}
export const snippetOrigin = (kind: SnippetKind) => snippetNode(kind).url
export function onSnippetPoolChange(callback: () => void): () => void { listeners.add(callback); return () => { listeners.delete(callback) } }

function validateNode(raw: unknown, kind: SnippetKind): SnippetNode {
  const node = raw as SnippetNode
  const url = new URL(node.url)
  if (!/^[\w-]{1,48}$/.test(node.id) || node.kind !== kind || url.protocol !== (kind === "rest" ? "https:" : "wss:") ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) throw new Error("服务器线路配置无效")
  return { id: node.id, name: String(node.name), kind, url: url.origin }
}

type Event = { node_id: string; outcome: "ok" | "error" | "limited"; latency_ms: number }
export async function refreshSnippetPool(force = false, event?: Event): Promise<void> {
  const current = token()
  if (!current) return
  if (identity && current !== identity) resetSnippetPool(false)
  if (flight) { await flight; if (force) return refreshSnippetPool(true, event); return }
  if (!force && known && Date.now() < nextRefresh) return
  const started = generation
  identity = current
  for (const [id, until] of excluded) if (until <= Date.now()) excluded.delete(id)
  flight = (async () => {
    try {
      const response = await fetch(base() + "/api/market/snippet-pool/lease", {
        method: "POST", headers: { Authorization: `Bearer ${current}`, "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: [...excluded.keys()], ...(event ? { event } : {}) }),
        signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error",
      })
      if (!response.ok) return
      const data = await response.json()
      if (started !== generation || current !== token()) return
      const next: typeof nodes = {}
      for (const kind of ["rest", "public_ws", "private_ws"] as const) if (data.nodes?.[kind]) next[kind] = validateNode(data.nodes[kind], kind)
      const changed = !known || JSON.stringify(next) !== JSON.stringify(nodes)
      known = true; nodes = next; nextRefresh = Date.now() + 30000
      if (changed) listeners.forEach(callback => callback())
    } catch { /* Last trusted configuration survives temporary product-server outages. */ }
  })().finally(() => { if (started === generation) flight = null })
  await flight
}

export async function snippetFailed(kind: SnippetKind, origin: string, limited = false): Promise<void> {
  let node: SnippetNode
  try { node = snippetNode(kind) } catch { return }
  if (node.url !== origin) return
  // Account/public-IP rate limits are not evidence that a proxy has died.
  if (!limited) excluded.set(node.id, Date.now() + 60000)
  const key = `${node.id}:${limited ? "limited" : "error"}`
  if ((sampled.get(key) || 0) > Date.now()) return
  sampled.set(key, Date.now() + 30000)
  await refreshSnippetPool(true, { node_id: node.id, outcome: limited ? "limited" : "error", latency_ms: 0 })
}

export function snippetSucceeded(kind: SnippetKind, origin: string, latencyMs = 0): void {
  let node: SnippetNode
  try { node = snippetNode(kind) } catch { return }
  const key = `${node.id}:ok`
  if (node.url !== origin || (sampled.get(key) || 0) > Date.now()) return
  sampled.set(key, Date.now() + 30000)
  void refreshSnippetPool(true, { node_id: node.id, outcome: "ok", latency_ms: Math.max(0, Math.min(300000, Math.round(latencyMs))) })
}

export function resetSnippetPool(release = true): void {
  const previous = identity
  generation++; flight = null; known = false; identity = ""; nodes = {}; nextRefresh = 0; excluded.clear(); sampled.clear()
  if (release && previous) void fetch(base() + "/api/market/snippet-pool/release", { method: "POST", headers: { Authorization: `Bearer ${previous}` }, keepalive: true }).catch(() => {})
  listeners.forEach(callback => callback())
}
