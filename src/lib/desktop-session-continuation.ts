import type { AccountSession } from './account-profiles'
import { sessionForTokens } from './account-sessions'
import { keepLocalSession } from './session-recovery'

/** An explicit continuation keeps the local-only restriction even if the
 * server is reachable; only the normal login form grants new task actions. */
export async function continueKnownDesktopSession(saved: AccountSession, nativeDesktop: boolean): Promise<AccountSession> {
  if (!nativeDesktop || !saved.user?.id || !saved.user.username || !saved.accessToken || saved.user.status === 'frozen') {
    throw Object.assign(new Error('请先完成服务器登录，再使用本机会话'), { status:401 })
  }
  let verified: AccountSession
  try { verified = await sessionForTokens(saved.accessToken, saved.refreshToken) }
  catch (error) {
    const status = (error as { status?:number } | null)?.status
    const unavailable = status === undefined || status >= 500 || status === 408 || status === 429
    if (unavailable && keepLocalSession(error, true, nativeDesktop)) return saved
    throw error
  }
  if (verified.user.id !== saved.user.id || verified.user.trading_mode !== saved.user.trading_mode) {
    throw Object.assign(new Error('账号会话不匹配，请重新登录'), { status:403 })
  }
  return verified
}
