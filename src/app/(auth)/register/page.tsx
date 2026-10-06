"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useAuthStore } from "@/stores/auth"
import { registerApi, getMeApi } from "@/lib/api"
import { BrandLogo } from "@/components/common/brand-logo"
import {
  getRegistrationStatusApi,
  type RegistrationStatus,
} from "@/lib/admin-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** 注册页面 —— 对接真实注册 + 注册策略提示 */
export default function RegisterPage(): React.JSX.Element {
  const router = useRouter()
  const { login } = useAuthStore()
  const [form, setForm] = useState({
    username: "",
    phone: "",
    password: "",
    confirmPassword: "",
    agreement: false,
  })
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [regStatus, setRegStatus] = useState<RegistrationStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const s = await getRegistrationStatusApi()
        if (!cancelled) setRegStatus(s)
      } catch {
        if (!cancelled) {
          setRegStatus(null)
        }
      } finally {
        if (!cancelled) setStatusLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  function updateField(field: string, value: string | boolean): void {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError("")

    if (regStatus && !regStatus.can_register) {
      setError(regStatus.reason || "当前不可注册")
      return
    }
    if (form.password !== form.confirmPassword) {
      setError("两次密码输入不一致")
      return
    }
    if (!form.agreement) {
      setError("请阅读并同意用户协议")
      return
    }
    if (form.username.length < 3) {
      setError("用户名至少 3 个字符")
      return
    }
    if (form.password.length < 6) {
      setError("密码至少 6 个字符")
      return
    }

    setLoading(true)
    try {
      const authRes = await registerApi({
        username: form.username,
        password: form.password,
        phone: form.phone || null,
      })
      localStorage.setItem("access_token", authRes.access_token)
      localStorage.setItem("refresh_token", authRes.refresh_token)
      useAuthStore.setState({ accessToken: authRes.access_token })

      const user = await getMeApi()
      login(user, authRes.access_token, authRes.refresh_token)
      // 整页跳转而非 SPA 路由：清空上一账号留在内存里的
      // 持仓/委托/任务等全部状态，杜绝跨账号数据残留
      window.location.assign("/dashboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败，请重试")
    } finally {
      setLoading(false)
    }
  }

  const blocked = Boolean(regStatus && !regStatus.can_register)

  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-[var(--bg-primary)] via-[var(--bg-secondary)] to-[var(--bg-primary)]">
      <div className="w-full max-w-md px-8 py-10 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <BrandLogo size={56} />
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            注册账号
          </h1>
          {regStatus?.system_name && (
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {regStatus.system_name}
            </p>
          )}
        </div>

        {statusLoading && (
          <p className="text-sm text-center text-[var(--text-muted)] mb-4">
            正在检查注册状态…
          </p>
        )}

        {!statusLoading && regStatus && (
          <div
            className={`mb-4 px-4 py-2.5 rounded-md text-sm text-center ${
              blocked
                ? "bg-[var(--accent-danger)]/15 text-[var(--accent-danger)]"
                : "bg-[var(--primary)]/10 text-[var(--text-secondary)]"
            }`}
          >
            {blocked ? (
              <span>{regStatus.reason || "当前不可注册"}</span>
            ) : (
              <span>
                开放注册
                {regStatus.daily_register_limit > 0 && (
                  <>
                    ，今日剩余{" "}
                    <strong className="text-[var(--text-primary)]">
                      {regStatus.remaining ?? 0}
                    </strong>{" "}
                    / {regStatus.daily_register_limit} 名额
                  </>
                )}
                （每日 {regStatus.register_reset_hour}:00 重置）
              </span>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="px-4 py-2.5 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm text-center">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              placeholder="字母/数字/下划线，至少 3 位"
              value={form.username}
              onChange={(e) => updateField("username", e.target.value)}
              required
              disabled={blocked}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">手机号（可选）</Label>
            <Input
              id="phone"
              placeholder="请输入手机号"
              value={form.phone}
              onChange={(e) => updateField("phone", e.target.value)}
              disabled={blocked}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              placeholder="至少 6 位"
              value={form.password}
              onChange={(e) => updateField("password", e.target.value)}
              required
              disabled={blocked}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">确认密码</Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder="请再次输入密码"
              value={form.confirmPassword}
              onChange={(e) => updateField("confirmPassword", e.target.value)}
              required
              disabled={blocked}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="agreement"
              checked={form.agreement}
              onChange={(e) => updateField("agreement", e.target.checked)}
              disabled={blocked}
              className="w-4 h-4 rounded border-[var(--border)] bg-[var(--bg-primary)] accent-[var(--primary)]"
            />
            <label
              htmlFor="agreement"
              className="text-sm text-[var(--text-muted)]"
            >
              我已阅读并同意{" "}
              <span className="text-[var(--primary)] cursor-pointer">
                《用户协议》
              </span>{" "}
              和{" "}
              <span className="text-[var(--primary)] cursor-pointer">
                《隐私政策》
              </span>
            </label>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading || blocked || statusLoading}
          >
            {loading ? "注册中..." : blocked ? "暂不可注册" : "注册"}
          </Button>
        </form>

        <div className="text-center mt-6 text-sm">
          <span className="text-[var(--text-muted)]">已有账号？</span>{" "}
          <Link href="/login" className="text-[var(--primary)] hover:underline">
            立即登录
          </Link>
        </div>
      </div>
    </div>
  )
}
