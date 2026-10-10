"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useAuthStore } from "@/stores/auth"
import { loginApi } from "@/lib/api"
import { sessionForTokens } from "@/lib/account-sessions"
import { resolveDesktopServerBase } from "@/desktop-boot"
import { loadServers, saveServer, deleteServer, selectServer, normalizeServerBase, type ServerProfile } from "@/lib/server-profiles"
import { BrandLogo } from "@/components/common/brand-logo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const REMEMBER_KEY = "qihuo_login_remember"
const SAVED_USER_KEY = "qihuo_login_username"
const SAVED_PASS_KEY = "qihuo_login_password"
const SERVER_OVERRIDE_KEY = "atd_desktop_server"

/** 后端系统身份(依据 FastAPI openapi info.title 判定,防连错期货系统后端) */
const BACKEND_TITLE = "加密货币交易系统"

/**
 * 连接测试:先拉 /openapi.json 判定系统身份(加密货币=通过;期货=明确拒绝;
 * 其他/无法解析 → 退回登录接口假凭据探测,422/401/400 = 服务器可达)
 */
async function probeServer(
  base: string,
): Promise<{ ok: boolean; detail: string }> {
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${base}/openapi.json`, { signal: ctrl.signal })
    if (res.ok) {
      const spec = (await res.json().catch(() => null)) as {
        info?: { title?: string }
      } | null
      const title = spec?.info?.title ?? ""
      if (title.includes("加密货币")) {
        return { ok: true, detail: `✓ 已连接 加密货币交易系统后端(${ms()}ms)` }
      }
      if (title.includes("期货")) {
        return {
          ok: false,
          detail: `✗ 这是【${title || "期货交易系统"}】后端,不是加密货币系统,请勿保存`,
        }
      }
      if (title) {
        return { ok: true, detail: `✓ 服务器可达(${ms()}ms),系统: ${title}` }
      }
    }
    // openapi 不可用(非 FastAPI/已关闭 docs)→ 用登录接口假凭据探测
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "__probe__", password: "__probe__" }),
      signal: ctrl.signal,
    })
    if ([401, 400, 422].includes(login.status)) {
      return { ok: true, detail: `✓ 服务器可达(${ms()}ms)` }
    }
    return { ok: false, detail: `✗ 有响应但状态异常 HTTP ${login.status}(${ms()}ms)` }
  } catch {
    const elapsed = ms()
    return {
      ok: false,
      detail:
        elapsed >= 7900 ? "✗ 超时:8秒无响应" : "✗ 无法连接(DNS/网络/防火墙拦截)",
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 网络类错误(failed to fetch / 网络错误 / 超时)识别——翻译成可操作提示 */
function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "")
  return /failed to fetch|networkerror|load failed|网络错误|请求超时|timeout|aborted/i.test(
    msg,
  )
}

/** 读取本地保存的登录信息 */
function loadRemembered(): {
  username: string
  password: string
  remember: boolean
} {
  if (typeof window === "undefined") {
    return { username: "", password: "", remember: false }
  }
  try {
    const remember = localStorage.getItem(REMEMBER_KEY) === "1"
    if (!remember) {
      return { username: "", password: "", remember: false }
    }
    return {
      username: localStorage.getItem(SAVED_USER_KEY) ?? "",
      password: localStorage.getItem(SAVED_PASS_KEY) ?? "",
      remember: true,
    }
  } catch {
    return { username: "", password: "", remember: false }
  }
}

/** 写入或清除记住的密码 */
function persistRemember(
  remember: boolean,
  username: string,
  password: string,
): void {
  try {
    if (remember) {
      localStorage.setItem(REMEMBER_KEY, "1")
      localStorage.setItem(SAVED_USER_KEY, username)
      localStorage.setItem(SAVED_PASS_KEY, password)
    } else {
      localStorage.removeItem(REMEMBER_KEY)
      localStorage.removeItem(SAVED_USER_KEY)
      localStorage.removeItem(SAVED_PASS_KEY)
    }
  } catch {
    // 隐私模式等写失败时忽略
  }
}

/** 登录页面 */
export default function LoginPage(): React.JSX.Element {
  const router = useRouter()
  const { login } = useAuthStore()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // 服务器入口设置(仅 Tauri 桌面端显示;浏览器 dev 走同域代理无需切换)
  const isTauri = Boolean(typeof window !== "undefined" && window.__TAURI_INTERNALS__)
  const [serverBase, setServerBase] = useState("")
  const [serverOverridden, setServerOverridden] = useState(false)
  const [showServerPanel, setShowServerPanel] = useState(true)
  const [customBase, setCustomBase] = useState("")
  const [servers, setServers] = useState<ServerProfile[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [serverName, setServerName] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState("")

  // 挂载后回填「记住密码」+ 当前服务器入口;未配置服务器时展开面板引导填写
  useEffect(() => {
    const saved = loadRemembered()
    setUsername(saved.username)
    setPassword(saved.password)
    setRemember(saved.remember)
    const base = resolveDesktopServerBase()
    setServerBase(base)
    setServers(loadServers())
    setServerOverridden(Boolean(localStorage.getItem(SERVER_OVERRIDE_KEY)))
    if (!base) setShowServerPanel(true)
    setHydrated(true)
  }, [])

  async function handleTestServer(base: string): Promise<void> {
    let norm: string
    try { norm = normalizeServerBase(base) } catch (e) { setTestResult(e instanceof Error ? e.message : "地址无效"); return }
    if (!norm) {
      setTestResult("✗ 请先填写服务器地址")
      return
    }
    setTesting(true)
    setTestResult("测试中...")
    const r = await probeServer(norm)
    setTestResult(r.detail)
    setTesting(false)
  }

  function handleSaveServer(base: string): void {
    try {
      const next = saveServer(servers, { id: editingId ?? crypto.randomUUID(), name: serverName, base })
      setServers(next); setEditingId(null); setCustomBase(""); setServerName("")
      setTestResult("✓ 已保存到服务器列表")
      const previous = servers.find(s => s.id === editingId)
      const updated = next.find(s => s.id === editingId)
      if (previous?.base === serverBase && updated && updated.base !== serverBase) handleSelectServer(updated.base)
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "保存失败")
    }
  }

  function handleSelectServer(base: string): void {
    if (base === serverBase) return
    try {
      selectServer(serverBase, base)
      window.location.assign(localStorage.getItem("access_token") ? "/dashboard" : "/login")
    } catch (e) { setTestResult(e instanceof Error ? e.message : "切换失败") }
  }

  function handleDeleteServer(profile: ServerProfile): void {
    try {
      const next = deleteServer(servers, profile.id)
      setServers(next)
      if (editingId === profile.id) { setEditingId(null); setCustomBase(""); setServerName("") }
      if (profile.base === serverBase) {
        if (next[0]) handleSelectServer(next[0].base)
        else {
          selectServer(serverBase, "https://b.00n.top")
          localStorage.removeItem(SERVER_OVERRIDE_KEY)
          window.location.assign("/login")
        }
      }
    } catch (e) { setTestResult(e instanceof Error ? e.message : "删除失败") }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError("")
    // 服务器未配置:不发注定失败的请求,直接引导设置
    if (isTauri && !serverBase) {
      setShowServerPanel(true)
      setError("请先在下方「服务器设置」中填写后端地址并保存")
      return
    }
    setLoading(true)

    try {
      const authRes = await loginApi({
        account: username,
        password,
        trading_mode: "live",
      })
      // Validate independently before replacing any current session.
      const { user } = await sessionForTokens(authRes.access_token, authRes.refresh_token)
      if (useAuthStore.getState().user?.id && useAuthStore.getState().user?.id !== user.id) {
        const { stopAllRealtime } = await import("@/lib/realtime-factor/runtime")
        await stopAllRealtime("切换账号，恢复普通模式")
      }
      login(
        { ...user, trading_mode: user.trading_mode ?? "live" },
        authRes.access_token,
        authRes.refresh_token,
      )
      persistRemember(remember, username, password)
      // 整页跳转而非 SPA 路由：换账号会话必须清空内存中
      // 上一账号的持仓/委托/任务等全部状态
      window.location.assign("/dashboard")
    } catch (err) {
      if (isNetworkError(err)) {
        const base = serverBase || resolveDesktopServerBase()
        setError(
          `无法连接服务器 ${base}——请检查网络,或用下方「服务器设置」测试并切换入口`,
        )
      } else {
        setError(err instanceof Error ? err.message : "账号或密码错误")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-[var(--bg-primary)] via-[var(--bg-secondary)] to-[var(--bg-primary)]">
      <div className="w-full max-w-md px-8 py-10 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <BrandLogo size={56} />
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            周期领航 · CyclePilot
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            AI驱动 · OKX / 币安 / 芝麻开门 三所对等交易终端
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="px-4 py-2.5 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm text-center">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={remember ? "current-password" : "off"}
              required
            />
          </div>

          <div className="flex items-center justify-between">
            <label
              htmlFor="remember"
              className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer select-none"
            >
              <input
                id="remember"
                type="checkbox"
                checked={remember}
                onChange={(e) => {
                  const next = e.target.checked
                  setRemember(next)
                  // 取消勾选时立即清掉本地保存
                  if (!next) {
                    persistRemember(false, "", "")
                  }
                }}
                className="w-4 h-4 rounded border-[var(--border)] bg-[var(--bg-primary)] accent-[var(--primary)]"
              />
              记住密码
            </label>
            <span className="text-xs text-[var(--text-muted)]">
              登录有效期 7 天
            </span>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading || !hydrated}
          >
            {loading ? "登录中..." : "登录"}
          </Button>
        </form>

        {isTauri && (
          <div className="mt-5 rounded-md border border-[var(--border)] px-3 py-2.5 text-xs">
            <button
              type="button"
              onClick={() => setShowServerPanel((v) => !v)}
              className="flex w-full items-center justify-between cursor-pointer"
            >
              <span className="text-[var(--text-muted)]">
                服务器:
                <span className="text-[var(--text-secondary)] ml-1">
                  {serverBase
                    ? serverBase.replace(/^https?:\/\//, "")
                    : "未设置(点击设置)"}
                </span>
                {serverOverridden && (
                  <span className="ml-1.5 text-[var(--accent-warn)]">(已自定义)</span>
                )}
              </span>
              <span className="text-[var(--primary)]">
                {showServerPanel ? "收起" : "设置"}
              </span>
            </button>

            {showServerPanel && (
              <div className="mt-3 space-y-3">
                <Label htmlFor="server-list">服务器列表</Label>
                <select id="server-list" value={serverBase} disabled={loading || testing}
                  onChange={e => handleSelectServer(e.target.value)}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-2 text-sm">
                  {!servers.some(s => s.base === serverBase) && <option value={serverBase}>{serverBase || "请选择服务器"}</option>}
                  {servers.map(s => <option key={s.id} value={s.base}>{s.name} · {s.base}</option>)}
                </select>
                <div className="max-h-36 overflow-y-auto space-y-2">
                  {servers.map(s => <div key={s.id} className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate" title={s.base}>{s.name}</span>
                    <button type="button" disabled={loading || testing} className="text-[var(--primary)]" onClick={() => {
                      setEditingId(s.id); setServerName(s.name); setCustomBase(s.base); setTestResult("")
                    }} aria-label={`编辑${s.name}`}>编辑</button>
                    <button type="button" disabled={loading || testing} className="text-[var(--accent-danger)]" onClick={() => handleDeleteServer(s)} aria-label={`删除${s.name}`}>删除</button>
                  </div>)}
                </div>
                <Label htmlFor="server-name">{editingId ? "编辑服务器" : "添加服务器"}</Label>
                <Input id="server-name" value={serverName} onChange={e => setServerName(e.target.value)} placeholder="服务器名称" maxLength={60} className="h-8 text-xs" />
                <Input
                  aria-label="服务器地址"
                  value={customBase}
                  onChange={(e) => setCustomBase(e.target.value)}
                  placeholder="后端地址,如 http://192.168.6.xx:8002 或 https://域名:端口"
                  className="h-8 text-xs"
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={testing || loading}
                    onClick={() => void handleTestServer(customBase)}
                  >
                    {testing ? "测试中..." : "测试连接"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={loading || testing}
                    onClick={() => handleSaveServer(customBase)}
                  >
                    {editingId ? "保存修改" : "添加到列表"}
                  </Button>
                  {editingId && <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingId(null); setServerName(""); setCustomBase("") }}>取消编辑</Button>}
                </div>
                {testResult && (
                  <div
                    className={
                      testResult.startsWith("✓")
                        ? "text-[var(--accent-success, #22c55e)]"
                        : "text-[var(--accent-danger)]"
                    }
                  >
                    {testResult}
                  </div>
                )}
                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                  {`选择服务器后立即切换连接；各服务器分别保存登录信息。填写${BACKEND_TITLE}后端地址，可先测试连接。`}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between mt-6 text-sm">
          <Link
            href="/register"
            className="text-[var(--primary)] hover:underline"
          >
            注册账号
          </Link>
          <button
            type="button"
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] cursor-pointer"
          >
            忘记密码？
          </button>
        </div>
      </div>
    </div>
  )
}
