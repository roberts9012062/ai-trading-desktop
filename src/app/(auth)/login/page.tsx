"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useAuthStore } from "@/stores/auth"
import { loginApi, getMeApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const REMEMBER_KEY = "qihuo_login_remember"
const SAVED_USER_KEY = "qihuo_login_username"
const SAVED_PASS_KEY = "qihuo_login_password"

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
  const [tradingMode, setTradingMode] = useState<"live" | "virtual">("live")
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // 挂载后回填「记住密码」
  useEffect(() => {
    const saved = loadRemembered()
    setUsername(saved.username)
    setPassword(saved.password)
    setRemember(saved.remember)
    setHydrated(true)
  }, [])

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const authRes = await loginApi({
        account: username,
        password,
        trading_mode: tradingMode,
      })
      // 先存 token，再获取用户信息（会话默认 7 天；盘模式绑定在 JWT）
      localStorage.setItem("access_token", authRes.access_token)
      localStorage.setItem("refresh_token", authRes.refresh_token)
      useAuthStore.setState({ accessToken: authRes.access_token })

      persistRemember(remember, username, password)

      const user = await getMeApi()
      login(
        { ...user, trading_mode: user.trading_mode ?? tradingMode },
        authRes.access_token,
        authRes.refresh_token,
      )
      router.push("/dashboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : "账号或密码错误")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--bg-primary)] via-[var(--bg-secondary)] to-[var(--bg-primary)]">
      <div className="w-full max-w-md px-8 py-10 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-xl bg-[var(--primary)] flex items-center justify-center text-white font-bold text-2xl mb-4">
            Q
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

          <div className="space-y-2">
            <Label>数据盘（登录后不可切换）</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTradingMode("live")}
                className={`h-10 rounded-md border text-sm transition-colors ${
                  tradingMode === "live"
                    ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--text-secondary)]"
                }`}
              >
                实盘交易
              </button>
              <button
                type="button"
                onClick={() => setTradingMode("virtual")}
                className={`h-10 rounded-md border text-sm transition-colors ${
                  tradingMode === "virtual"
                    ? "border-[var(--accent-warn)] bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]"
                    : "border-[var(--border)] text-[var(--text-secondary)]"
                }`}
              >
                虚拟盘
              </button>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              {tradingMode === "live"
                ? "实盘：直连 OKX / 币安 / 芝麻开门 真实下单（需配置 API 凭证）"
                : "虚拟盘：7×24 模拟撮合 + 独立虚拟资金（与实盘完全隔离）"}
            </p>
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
