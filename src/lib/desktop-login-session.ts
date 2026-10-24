/** A login confirmation belongs to one native process, never a saved JWT.
 * Keep it in session storage so an explicit account switch can reload the
 * renderer without pretending that a new application launch was authenticated. */
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const VERIFIED_RUN = 'atd_verified_login_run'
const VERIFIED_MODE = 'atd_verified_login_mode'
let run = '', storage: SessionStorage | null = null, required = true, localOnly = false
const listeners = new Set<() => void>()

export const desktopLoginRequired = () => required
export const desktopSessionLocalOnly = () => localOnly
export function onDesktopLoginChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: boolean, local = localOnly) { if (required === next && localOnly === local) return; required = next; localOnly = local; listeners.forEach(listener => listener()) }

export function initializeDesktopLoginSession(id: string, session?: SessionStorage): void {
  run = id
  storage = session ?? null
  if (!session && typeof window !== 'undefined') {
    try { storage = window.sessionStorage } catch { /* Remain locked until explicit login. */ }
  }
  let verified = false
  try { verified = !!run && storage?.getItem(VERIFIED_RUN) === run } catch { /* No persisted confirmation. */ }
  let local = false
  try { local = verified && storage?.getItem(VERIFIED_MODE) === 'local' } catch { /* Keep a new launch locked. */ }
  publish(!verified, local)
}

/** Call only after successful explicit server/account validation. */
export function completeDesktopLogin(mode: 'server' | 'local' = 'server'): void {
  if (!run) return
  try { storage?.setItem(VERIFIED_MODE, mode); storage?.setItem(VERIFIED_RUN, run) } catch { /* This renderer can still sign in. */ }
  publish(false, mode === 'local')
}

export function requireDesktopLogin(): void {
  try { storage?.removeItem(VERIFIED_RUN); storage?.removeItem(VERIFIED_MODE) } catch { /* The in-memory lock still applies. */ }
  publish(true)
}

export function assertServerLoginForTasks(): void {
  if (localOnly) throw Object.assign(new Error('当前为本机离线会话，请先完成服务器登录，再创建或重新启动任务'), { status: 401, code: 'LOCAL_SESSION_ONLY' })
  if (run && required) throw Object.assign(new Error('请先完成本次启动的服务器登录，再创建或重新启动任务'), { status: 401, code: 'DESKTOP_LOGIN_REQUIRED' })
}
