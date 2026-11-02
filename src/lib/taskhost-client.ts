/** Go hosting sessions are separate from legacy JWT/account/executor state. */
export type HostSession =
  | {
      mode: "server";
      origin: string;
      token: string;
      ownerID: string;
      expiresAt: string;
    }
  | { mode: "standalone"; scope: string; centerUserID: string };
export interface HostedTask {
  id: string;
  name: string;
  kind: "ai" | "shortline";
  symbol: string;
  credential_id: string;
  status: string;
  revision: number;
}
export interface HostedTaskInput {
  request_id: string;
  name: string;
  kind: "ai" | "shortline";
  symbol: string;
  credential_id: string;
  config: Record<string, unknown>;
}
export interface HostCredential {
  id: string;
  venue: string;
  label: string;
  demo: boolean;
  api_key_masked: string;
}
export interface CenterTask {
  task_id: string;
  subject: string;
  authority: string;
  desired_state: string;
  revision: number;
  config?: {
    task?: { name?: string; symbol?: string; strategy_type?: string };
  };
}
export interface CenterAccount {
  account_id: string;
  epoch: number;
  role: string;
  recovery_required: boolean;
  unresolved_commands: boolean;
  tasks: CenterTask[];
}
const SESSION = "cyclepilot_go_host_session";
let current: HostSession | null = null,
  epoch = 0;
const listeners = new Set<() => void>();
export const hostSession = () => current;
export function onHostSessionChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function publish(session: HostSession | null) {
  current = session;
  epoch++;
  listeners.forEach((fn) => fn());
}
function save(session: HostSession | null) {
  try {
    if (session) sessionStorage.setItem(SESSION, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION);
  } catch {
    /* Memory-only session remains valid. */
  }
}
export function logoutHost() {
  save(null);
  publish(null);
}
export function enterStandalone(session: {
  scope: string;
  centerUserID: string;
}) {
  const next = { mode: "standalone" as const, ...session };
  save(next);
  publish(next);
}
export function restoreHostSession() {
  if (current) return;
  try {
    const s = JSON.parse(
      sessionStorage.getItem(SESSION) || "null",
    ) as HostSession | null;
    if (
      s?.mode === "server" &&
      s.origin === normalizeHost(s.origin) &&
      s.token &&
      s.ownerID &&
      Date.parse(s.expiresAt) > Date.now()
    )
      publish(s);
    else if (s?.mode === "standalone" && s.scope && s.centerUserID) publish(s);
  } catch {
    /* A fresh explicit login is required for invalid persisted state. */
  }
}
export function normalizeHost(raw: string): string {
  const text = raw.trim(),
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  )
    throw new Error(
      "远程服务器必须使用 HTTPS 地址，且不能包含账号、路径或查询参数",
    );
  return url.origin;
}
async function parsed(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof body?.detail === "string"
          ? body.detail
          : `服务器请求失败 (${response.status})`,
      ),
      { status: response.status, code: body?.code },
    );
  if (!body || typeof body !== "object") throw new Error("服务器响应无效");
  return body;
}
export async function loginHost(rawOrigin: string, key: string) {
  const origin = normalizeHost(rawOrigin),
    started = epoch;
  if (!/^thk_[A-Za-z0-9_-]{43}$/.test(key))
    throw new Error("请填写管理后台签发的完整登录密钥");
  const health = await parsed(
    await fetch(origin + "/api/health", {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    }),
  );
  if (health.service !== "taskhost-go" || health.initialized !== true)
    throw new Error("这不是已初始化的 Go 任务托管服务器");
  if (started !== epoch) throw new Error("会话已变化，请重新连接");
  const body = await parsed(
    await fetch(origin + "/api/v1/handshake", {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login_key: key }),
    }),
  );
  if (started !== epoch) throw new Error("会话已变化，请重新连接");
  if (
    body.service !== "taskhost-go" ||
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.owner_id !== "string" ||
    typeof body.expires_at !== "string" ||
    !(Date.parse(body.expires_at) > Date.now())
  )
    throw new Error("服务器未返回有效握手凭证");
  const next: HostSession = {
    mode: "server",
    origin,
    token: body.access_token,
    ownerID: body.owner_id,
    expiresAt: body.expires_at,
  };
  save(next);
  publish(next);
  return next;
}
export async function hostRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const session = current,
    started = epoch;
  if (session?.mode !== "server")
    throw new Error("请先连接服务器；单机模式不能创建或修改服务器任务");
  if (Date.parse(session.expiresAt) <= Date.now()) {
    logoutHost();
    throw new Error("服务器会话已到期，请重新握手");
  }
  if (
    !/^\/api\/v1\/(?:tasks(?:\/[A-Za-z0-9_-]+\/(?:start|pause))?|credentials(?:\/[A-Za-z0-9_-]+)?|collection(?:\/accounts)?|capabilities|session|logout)$/.test(
      path,
    )
  )
    throw new Error("不支持的任务服务器接口");
  const response = await fetch(session.origin + path, {
    ...options,
    cache: "no-store",
    redirect: "error",
    signal: options.signal ?? AbortSignal.timeout(20000),
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      Authorization: `Bearer ${session.token}`,
    },
  });
  if (started !== epoch) throw new Error("会话已变化，已取消原连接的响应");
  let out: Record<string, unknown>;
  try {
    out = await parsed(response);
  } catch (error) {
    if ((error as { status?: number }).status === 401 && started === epoch)
      logoutHost();
    throw error;
  }
  if (started !== epoch) throw new Error("会话已变化，已取消原连接的响应");
  return out as T;
}
export async function createHostedTask(
  input: HostedTaskInput,
): Promise<HostedTask> {
  if (current?.mode !== "server")
    throw new Error("新建任务必须连接服务器，单机模式只能操作已有托管任务");
  try {
    return await hostRequest<HostedTask>("/api/v1/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name))
    )
      throw new Error(
        "服务器连接中断，创建结果未确认。请刷新任务列表核对；保留原请求编号，不会离线创建或自动重试。",
      );
    throw error;
  }
}
