import { normalizeUser } from "./api"
import type { AccountSession } from "./account-profiles"
const base = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** Explicit credentials: probing another session must never mutate the active one. */
async function isolated<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { "Content-Type":"application/json", ...init.headers } })
  const body = await response.json().catch(()=>({}))
  if(!response.ok) throw Object.assign(new Error(typeof body.detail === "string" ? body.detail : "账号验证失败，请重试"), { status:response.status })
  return body as T
}
export async function sessionForTokens(accessToken: string, refreshToken: string): Promise<AccountSession> {
  const raw = await isolated<Record<string,unknown>>("/api/auth/me",{ headers:{ Authorization:`Bearer ${accessToken}` } })
  const user = normalizeUser(raw)
  if(!user.id || !user.username || user.status === "frozen") throw new Error("该账号不可用")
  return { user, accessToken, refreshToken }
}
export async function signInAccount(username: string, password: string): Promise<AccountSession> {
  const tokens = await isolated<{access_token:string;refresh_token:string}>("/api/auth/desktop-login", { method:"POST",body:JSON.stringify({username,password,trading_mode:"live"}) })
  return sessionForTokens(tokens.access_token,tokens.refresh_token)
}
export async function validateAccount(session: AccountSession): Promise<AccountSession> {
  let verified: AccountSession
  try { verified = await sessionForTokens(session.accessToken,session.refreshToken) }
  catch(error) {
    if((error as {status?:number}).status !== 401) throw error
    const tokens = await isolated<{access_token:string;refresh_token:string}>("/api/auth/refresh", { method:"POST",body:JSON.stringify({refresh_token:session.refreshToken}) })
    verified = await sessionForTokens(tokens.access_token,tokens.refresh_token)
  }
  if(verified.user.id !== session.user.id || verified.user.trading_mode !== session.user.trading_mode) throw new Error("账号会话不匹配，请重新登录该账号")
  return verified
}
