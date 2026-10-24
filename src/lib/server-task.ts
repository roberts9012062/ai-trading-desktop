/** Creation is an online, authenticated server operation; it is never queued. */
import { assertServerLoginForTasks, desktopSessionLocalOnly } from './desktop-login-session'
function identity(): string {
  return JSON.stringify([localStorage.getItem('access_token'), localStorage.getItem('qihuo_auth_user'), localStorage.getItem('atd_desktop_server'), desktopSessionLocalOnly()])
}

export class ServerTaskError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message) }
}

export async function createServerTask<T>(base: string, path: string, body: unknown): Promise<T> {
  assertServerLoginForTasks()
  const token = typeof localStorage === 'undefined' ? null : localStorage.getItem('access_token')
  if (!token) throw new ServerTaskError('创建任务需要服务器登录，请先登录服务器', 401)
  if (!['/api/ai-trading/tasks', '/api/shortline/tasks'].includes(path)) throw new ServerTaskError('不支持的服务器任务创建接口')
  const owner = identity()
  let response: Response
  try {
    response = await fetch(base + path, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    })
  } catch {
    throw new ServerTaskError('服务器连接中断，任务创建结果未确认。请恢复连接后刷新任务列表确认；不会离线创建或自动重试')
  }
  if (owner !== identity()) throw new ServerTaskError('账号或服务器已切换，请刷新当前服务器的任务列表')
  if (response.status === 401) throw new ServerTaskError('服务器登录已失效，请重新登录后创建任务', 401)
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message = response.status >= 500 ? '服务器暂不可用，无法确认任务创建结果，请恢复连接后刷新任务列表' : typeof data?.detail === 'string' ? data.detail : `服务器拒绝创建任务 (${response.status})`
    throw new ServerTaskError(message, response.status, typeof data?.code === 'string' ? data.code : undefined)
  }
  if (!data || !['string', 'number'].includes(typeof data.id) || String(data.id).trim() === '') throw new ServerTaskError('服务器未返回有效任务编号，请刷新任务列表确认；不会生成本地任务编号')
  return data as T
}
