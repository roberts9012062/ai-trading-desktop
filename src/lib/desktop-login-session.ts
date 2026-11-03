/** A login confirmation belongs to one native process, never a saved JWT.
 * Keep it in session storage so an explicit account switch can reload the
 * renderer without pretending that a new application launch was authenticated. */
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const VERIFIED_RUN = 'atd_verified_login_run'
const VERIFIED_MODE = 'atd_verified_login_mode'
const VERIFIED_TRANSPORT = 'atd_verified_login_transport'
type DesktopTransport = 'legacy' | 'taskhost'
let run = '', storage: SessionStorage | null = null, required = true, localOnly = false, transport: DesktopTransport = 'legacy'
const listeners = new Set<() => void>()

export const desktopLoginRequired = () => required
export const desktopSessionLocalOnly = () => localOnly
/** UI session routing is separate from trading authority and legacy JWTs. */
export const desktopSessionUsesTaskHost = () => transport === 'taskhost'
export function onDesktopLoginChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: boolean, local = localOnly, source = transport) { if (required === next && localOnly === local && transport === source) return; required = next; localOnly = local; transport = source; listeners.forEach(listener => listener()) }

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
  let source: DesktopTransport = 'legacy'
  try { if (verified && storage?.getItem(VERIFIED_TRANSPORT) === 'taskhost') source = 'taskhost' } catch { /* A failed restore never installs a host identity. */ }
  publish(!verified, local, source)
}

/** Call only after successful explicit server/account validation. */
export function completeDesktopLogin(mode: 'server' | 'local' = 'server', source: DesktopTransport = 'legacy'): void {
  if (!run) return
  try { storage?.setItem(VERIFIED_MODE, mode); storage?.setItem(VERIFIED_TRANSPORT, source); storage?.setItem(VERIFIED_RUN, run) } catch { /* This renderer can still sign in. */ }
  publish(false, mode === 'local', source)
}

export function requireDesktopLogin(): void {
  try { storage?.removeItem(VERIFIED_RUN); storage?.removeItem(VERIFIED_MODE); storage?.removeItem(VERIFIED_TRANSPORT) } catch { /* The in-memory lock still applies. */ }
  publish(true)
}

export function assertServerLoginForTasks(): void {
  if (transport === 'taskhost') throw Object.assign(new Error('当前使用 Go 任务托管连接，请在任务托管页面创建或启动任务'), { status: 409, code: 'TASKHOST_SESSION_ONLY' })
  if (localOnly) throw Object.assign(new Error('当前为本机离线会话，请先完成服务器登录，再创建或重新启动任务'), { status: 401, code: 'LOCAL_SESSION_ONLY' })
  if (run && required) throw Object.assign(new Error('请先完成本次启动的服务器登录，再创建或重新启动任务'), { status: 401, code: 'DESKTOP_LOGIN_REQUIRED' })
}

/** Restoring navigation cannot authorize the old engine's financial writes. */
export function assertLegacyTradingWrite(path: string, options: RequestInit = {}): void {
  if (transport !== 'taskhost' || ['GET','HEAD'].includes((options.method || 'GET').toUpperCase())) return
  const route = path.split('?')[0]
  if (/^\/api\/(?:ai-trading\/tasks|shortline\/tasks)(?:\/|$)/.test(route) || route.startsWith('/api/live/') && !/^\/api\/live\/(?:credentials(?:\/okx)?|desktop-ws-login)$/.test(route)) {
    throw Object.assign(new Error('当前连接使用 Go 交易执行器，请在任务托管页面操作对应任务'), { status: 409, code: 'TASKHOST_SESSION_ONLY' })
  }
}
