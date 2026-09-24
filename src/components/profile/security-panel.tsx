"use client"

/**
 * 安全设置面板 —— 修改密码
 *
 * 调 PUT /api/users/me/password（old_password + new_password）。
 * JWT 无状态：改密成功后旧 token 仍有效，故强制登出并跳登录页重登，
 * 同时让两个交易盘（live/virtual）会话一并失效，避免串用。
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { changePasswordApi } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { cn } from "@/lib/utils"

/** 提交状态机 */
type SubmitStatus = "idle" | "loading" | "success" | "error"

/** 密码长度下限（与后端 ChangePasswordRequest min_length 对齐） */
const PWD_MIN = 6
const PWD_MAX = 100

/** 表单校验：通过返回 null，否则返回中文错误 */
function validateForm(
  oldPwd: string,
  newPwd: string,
  confirmPwd: string,
): string | null {
  if (!oldPwd) {
    return "请输入当前密码"
  }
  if (newPwd.length < PWD_MIN || newPwd.length > PWD_MAX) {
    return `新密码长度需为 ${PWD_MIN}-${PWD_MAX} 位`
  }
  if (newPwd === oldPwd) {
    return "新密码不能与当前密码相同"
  }
  if (newPwd !== confirmPwd) {
    return "两次输入的新密码不一致"
  }
  return null
}

export function SecurityPanel(): React.JSX.Element {
  const [oldPwd, setOldPwd] = useState("")
  const [newPwd, setNewPwd] = useState("")
  const [confirmPwd, setConfirmPwd] = useState("")
  const [status, setStatus] = useState<SubmitStatus>("idle")
  const [msg, setMsg] = useState("")

  const logout = useAuthStore((s) => s.logout)
  const router = useRouter()

  function resetForm(): void {
    setOldPwd("")
    setNewPwd("")
    setConfirmPwd("")
  }

  async function handleSubmit(): Promise<void> {
    const err = validateForm(oldPwd, newPwd, confirmPwd)
    if (err !== null) {
      setStatus("error")
      setMsg(err)
      return
    }

    setStatus("loading")
    setMsg("")
    try {
      await changePasswordApi(oldPwd, newPwd)
      setStatus("success")
      setMsg("密码修改成功，即将返回登录页重新登录…")
      resetForm()
      // 留 1.5s 让用户看到提示，再登出跳转
      setTimeout(() => {
        logout()
        router.replace("/login")
      }, 1500)
    } catch (e) {
      setStatus("error")
      setMsg(e instanceof Error ? e.message : "密码修改失败，请稍后重试")
    }
  }

  const busy = status === "loading" || status === "success"

  return (
    <div className="max-w-xl space-y-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        安全设置
      </h2>

      {/* 修改密码 */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            修改密码
          </p>
          <Separator />
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-[var(--text-secondary)]">
                当前密码
              </Label>
              <Input
                type="password"
                placeholder="请输入当前密码"
                className="h-8 mt-1 text-sm"
                value={oldPwd}
                autoComplete="current-password"
                disabled={busy}
                onChange={(e) => setOldPwd(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs text-[var(--text-secondary)]">
                新密码
              </Label>
              <Input
                type="password"
                placeholder={`请输入新密码（${PWD_MIN}-${PWD_MAX} 位）`}
                className="h-8 mt-1 text-sm"
                value={newPwd}
                autoComplete="new-password"
                disabled={busy}
                onChange={(e) => setNewPwd(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs text-[var(--text-secondary)]">
                确认新密码
              </Label>
              <Input
                type="password"
                placeholder="请再次输入新密码"
                className="h-8 mt-1 text-sm"
                value={confirmPwd}
                autoComplete="new-password"
                disabled={busy}
                onChange={(e) => setConfirmPwd(e.target.value)}
              />
            </div>
          </div>

          {/* 提示行 */}
          {msg && (
            <p
              className={cn(
                "text-xs",
                status === "success"
                  ? "text-up"
                  : "text-[var(--accent-danger)]",
              )}
            >
              {msg}
            </p>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {status === "loading" ? "提交中…" : status === "success" ? "已修改" : "确认修改"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Google 验证器（二期） */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Google 验证器
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                增强账户安全性，提现和关键操作需二次验证
              </p>
            </div>
            <Badge variant="outline">未绑定</Badge>
          </div>
          <Separator />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled>
              绑定验证器
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
