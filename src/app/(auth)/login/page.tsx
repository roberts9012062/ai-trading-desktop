"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useAuthStore } from "@/stores/auth"
import { loginApi, getMeApi } from "@/lib/api"
import { resolveDesktopServerBase } from "@/desktop-boot"
import { BrandLogo } from "@/components/common/brand-logo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const REMEMBER_KEY = "qihuo_login_remember"
const SAVED_USER_KEY = "qihuo_login_username"
const SAVED_PASS_KEY = "qihuo_login_password"
const SERVER_OVERRIDE_KEY = "atd_desktop_server"

/** 预置服务器入口(DT 后端部署就绪后在此登记;当前留空,用户用自定义入口填写) */
const PRESET_SERVERS: Array<{ label: string; base: string }> = [
  { label: "公网入口", base: "https://b.00n.top" },
  { label: "直连备用", base: "http://143.47.108.63:8002" },
]

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

/** 规范化服务器地址:补协议、去尾部斜杠 */
function normalizeServerBase(raw: string): string {
  let v = raw.trim()
  if (!v) return ""
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`
  return v.replace(/\/+$/, "")
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
  const [showServerPanel, setShowServerPanel] = useState(false)
  const [customBase, setCustomBase] = useState("")
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
    setCustomBase(base)
    setServerOverridden(Boolean(localStorage.getItem(SERVER_OVERRIDE_KEY)))
    if (!base) setShowServerPanel(true)
    setHydrated(true)
  }, [])

  async function handleTestServer(base: string): Promise<void> {
    const norm = normalizeServerBase(base)
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
    const norm = normalizeServerBase(base)
    if (!norm) {
      setTestResult("✗ 请先填写服务器地址")
      return
    }
    try {
      localStorage.setItem(SERVER_OVERRIDE_KEY, norm)
    } catch {
      // 写失败时静默
    }
    location.reload()
  }

  function handleResetServer(): void {
    try {
      localStorage.removeItem(SERVER_OVERRIDE_KEY)
    } catch {
      // 同上
    }
    location.reload()
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
      // 先存 token，再获取用户信息（会话默认 7 天；盘模式绑定在 JWT）
      localStorage.setItem("access_token", authRes.access_token)
      localStorage.setItem("refresh_token", authRes.refresh_token)
      useAuthStore.setState({ accessToken: authRes.access_token })

      persistRemember(remember, username, password)

      const user = await getMeApi()
      login(
        { ...user, trading_mode: user.trading_mode ?? "live" },
        authRes.access_token,
        authRes.refresh_token,
      )
      router.push("/dashboard")
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--bg-primary)] via-[var(--bg-secondary)] to-[var(--bg-primary)]">
      <div className="w-full max-w-md px-8 py-10 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <BrandLogo size={56} />
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            加密货币交易系统
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
                {PRESET_SERVERS.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {PRESET_SERVERS.map((p) => (
                      <button
                        key={p.base}
                        type="button"
                        onClick={() => {
                          setCustomBase(p.base)
                          void handleTestServer(p.base)
                        }}
                        className={`h-8 rounded-md border text-xs transition-colors ${
                          serverBase === p.base
                            ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                            : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--primary)]/50"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
                <Input
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
                    disabled={testing}
                    onClick={() => void handleTestServer(customBase)}
                  >
                    {testing ? "测试中..." : "测试连接"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSaveServer(customBase)}
                  >
                    保存并生效
                  </Button>
                  {serverOverridden && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={handleResetServer}
                    >
                      恢复默认
                    </Button>
                  )}
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
                  {`填写加密货币交易系统(${BACKEND_TITLE})后端地址;测试会校验后端身份,期货系统后端将被拒绝`}
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
