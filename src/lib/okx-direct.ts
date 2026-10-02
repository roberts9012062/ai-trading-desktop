/**
 * OKX 本地直连：签名请求 + 账单历史分页 + 按日盈亏聚合 + 本地缓存。
 *
 * 与业务服务器零交互：API 凭据仅存本机 localStorage；HMAC-SHA256 签名用
 * WebCrypto 在本地计算；HTTP 走桌面端 Tauri http fetch（desktop-boot 已替换
 * window.fetch，天然绕过 CORS），失败时在 www.okx.com / aws.okx.com 之间轮换。
 */

export type OkxInstType = "SWAP" | "FUTURES" | "MARGIN"

export interface OkxLocalCredentials {
  apiKey: string
  secret: string
  passphrase: string
  demo: boolean
}

const CREDS_KEY = "atd-local-okx-creds-v1"
const CACHE_KEY = "atd-okx-daily-pnl-cache-v1"
const OKX_HOSTS = ["https://www.okx.com", "https://aws.okx.com"]

export function loadLocalOkxCredentials(): OkxLocalCredentials | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<OkxLocalCredentials>
    if (!c.apiKey || !c.secret) return null
    return {
      apiKey: c.apiKey,
      secret: c.secret,
      passphrase: c.passphrase ?? "",
      demo: Boolean(c.demo),
    }
  } catch {
    return null
  }
}

export function saveLocalOkxCredentials(c: OkxLocalCredentials): void {
  localStorage.setItem(CREDS_KEY, JSON.stringify(c))
}

export function clearLocalOkxCredentials(): void {
  localStorage.removeItem(CREDS_KEY)
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return toBase64(sig)
}

interface OkxApiError extends Error {
  code?: string
}

/** OKX v5 签名 GET：业务错误（签名/权限/参数）直接抛出，网络错误换域名重试 */
async function okxSignedGet<T>(
  path: string,
  params: Record<string, string | number>,
  creds: OkxLocalCredentials,
  timeoutMs = 15_000,
): Promise<T> {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&")
  const requestPath = query ? `${path}?${query}` : path
  const timestamp = new Date().toISOString()
  const sign = await hmacSha256Base64(creds.secret, `${timestamp}GET${requestPath}`)
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": creds.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": creds.passphrase,
    "Content-Type": "application/json",
  }
  if (creds.demo) headers["x-simulated-trading"] = "1"

  let lastErr: unknown = null
  for (const host of OKX_HOSTS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${host}${requestPath}`, { headers, signal: controller.signal })
      const body = (await res.json().catch(() => null)) as {
        code?: string
        msg?: string
        error?: string[] | string
        data?: T
      } | null
      if (!body) throw new Error(`OKX 返回格式异常（HTTP ${res.status}）`)
      if (body.code !== "0") {
        const detail = Array.isArray(body.error)
          ? body.error.join("；")
          : typeof body.error === "string"
            ? body.error
            : body.msg
        const err = new Error(
          `OKX ${body.code ?? `HTTP ${res.status}`}${detail ? `：${String(detail).slice(0, 180)}` : ""}`,
        ) as OkxApiError
        err.code = body.code
        throw err
      }
      return body.data as T
    } catch (e) {
      const apiErr = e as OkxApiError
      if (apiErr instanceof Error && apiErr.code) throw apiErr
      lastErr = e
    } finally {
      clearTimeout(timer)
    }
  }
  const hint = lastErr instanceof Error ? `：${lastErr.message.slice(0, 120)}` : ""
  throw new Error(`无法连接 OKX（www.okx.com 与 aws.okx.com 均失败，请检查网络）${hint}`)
}

export interface OkxBill {
  billId: string
  instId?: string
  /** 1=转账 2=交易 3=交割 5=强平 等；转账不产生盈亏 */
  type?: string
  subType?: string
  /** 毫秒时间戳（字符串） */
  ts: string
  pnl?: string
  fee?: string
  fundingFee?: string
}

/**
 * 分页拉取账单历史（新→旧），拉到 sinceTsMs 之前或翻完为止。
 * 用 after=billId 翻页，每页 100 条，页间小睡避开限频；上限 300 页防失控。
 */
export async function fetchOkxBillsSince(opts: {
  instType: OkxInstType
  sinceTsMs: number
  creds: OkxLocalCredentials
  onProgress?: (count: number) => void
  maxPages?: number
}): Promise<OkxBill[]> {
  const out: OkxBill[] = []
  const maxPages = opts.maxPages ?? 300
  let after: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const params: Record<string, string | number> = {
      instType: opts.instType,
      limit: 100,
    }
    if (after) params.after = after
    const data = await okxSignedGet<OkxBill[]>(
      "/api/v5/account/bills-history",
      params,
      opts.creds,
    )
    if (!Array.isArray(data) || data.length === 0) break
    let oldestTs = Infinity
    for (const b of data) {
      const ts = Number(b.ts)
      if (!Number.isFinite(ts)) continue
      if (ts < oldestTs) oldestTs = ts
      if (ts >= opts.sinceTsMs) out.push(b)
    }
    opts.onProgress?.(out.length)
    if (oldestTs < opts.sinceTsMs) break
    const nextAfter = data[data.length - 1].billId
    if (!nextAfter) break
    after = nextAfter
    await new Promise((r) => setTimeout(r, 120))
  }
  return out
}

function num(v: string | undefined): number {
  if (v == null || v === "") return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export interface DailyPnlEntry {
  /** 已实现盈亏 + 手续费 + 资金费（USDT 计价口径） */
  pnl: number
  /** 交易类账单笔数（平仓/交割/强平） */
  count: number
}

export type DailyPnlMap = Record<string, DailyPnlEntry>

/** 账单毫秒时间戳 → 本机时区自然日 key（YYYY-MM-DD），与日历视图同一口径 */
export function dayKeyLocal(tsMs: number): string {
  const d = new Date(tsMs)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 按日聚合：跳过纯转账；盈亏 = pnl + fee + fundingFee */
export function aggregateDailyPnl(bills: OkxBill[]): DailyPnlMap {
  const days: DailyPnlMap = {}
  for (const b of bills) {
    const ts = Number(b.ts)
    if (!Number.isFinite(ts)) continue
    if (b.type === "1") continue
    const v = num(b.pnl) + num(b.fee) + num(b.fundingFee)
    const isTrade = b.type === "2" || b.type === "3" || b.type === "5"
    if (v === 0 && !isTrade) continue
    const key = dayKeyLocal(ts)
    const day = days[key] ?? { pnl: 0, count: 0 }
    day.pnl += v
    if (isTrade) day.count += 1
    days[key] = day
  }
  return days
}

export interface OkxDailyPnlCache {
  version: 1
  instType: OkxInstType
  demo: boolean
  fetchedAt: number
  windowDays: number
  days: DailyPnlMap
}

export function loadOkxDailyCache(instType: OkxInstType): OkxDailyPnlCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<OkxDailyPnlCache>
    if (c.version !== 1 || c.instType !== instType || !c.days) return null
    return {
      version: 1,
      instType,
      demo: Boolean(c.demo),
      fetchedAt: Number(c.fetchedAt) || 0,
      windowDays: Number(c.windowDays) || 90,
      days: c.days,
    }
  } catch {
    return null
  }
}

export function saveOkxDailyCache(c: OkxDailyPnlCache): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(c))
}

export function clearOkxDailyCache(): void {
  localStorage.removeItem(CACHE_KEY)
}

/** 全窗口重拉并落缓存（简单可靠：增量合并边界靠 billId 不可靠） */
export async function refreshOkxDailyPnl(opts: {
  instType: OkxInstType
  creds: OkxLocalCredentials
  windowDays?: number
  onProgress?: (count: number) => void
}): Promise<OkxDailyPnlCache> {
  const windowDays = opts.windowDays ?? 90
  const since = Date.now() - windowDays * 86_400_000
  const bills = await fetchOkxBillsSince({
    instType: opts.instType,
    sinceTsMs: since,
    creds: opts.creds,
    onProgress: opts.onProgress,
  })
  const cache: OkxDailyPnlCache = {
    version: 1,
    instType: opts.instType,
    demo: opts.creds.demo,
    fetchedAt: Date.now(),
    windowDays,
    days: aggregateDailyPnl(bills),
  }
  saveOkxDailyCache(cache)
  return cache
}

/** 连通性测试：拉总权益 */
export async function testOkxConnection(
  creds: OkxLocalCredentials,
): Promise<{ equity: number }> {
  const data = await okxSignedGet<{ totalEq?: string }[]>(
    "/api/v5/account/balance",
    { ccy: "USDT" },
    creds,
  )
  const equity = Number(data?.[0]?.totalEq ?? 0)
  return { equity: Number.isFinite(equity) ? equity : 0 }
}
