"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdminUserApi } from "@/lib/admin-api"

interface UserCreateFormProps {
  onCreated: () => Promise<void>
  onError: (message: string) => void
  onCancel: () => void
}

/** 管理员新增用户表单 */
export function UserCreateForm({
  onCreated,
  onError,
  onCancel,
}: UserCreateFormProps): React.JSX.Element {
  const [form, setForm] = useState({
    username: "",
    password: "",
    phone: "",
    role: "user" as "user" | "admin",
  })
  const [saving, setSaving] = useState(false)

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setSaving(true)
    try {
      await createAdminUserApi({
        username: form.username,
        password: form.password,
        phone: form.phone || null,
        role: form.role,
      })
      setForm({ username: "", password: "", phone: "", role: "user" })
      await onCreated()
    } catch (err) {
      onError(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <form
          onSubmit={handleCreate}
          className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end"
        >
          <div className="space-y-1">
            <Label>用户名</Label>
            <Input
              value={form.username}
              onChange={(e) =>
                setForm((f) => ({ ...f, username: e.target.value }))
              }
              required
              minLength={3}
            />
          </div>
          <div className="space-y-1">
            <Label>密码</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
              required
              minLength={6}
            />
          </div>
          <div className="space-y-1">
            <Label>手机号</Label>
            <Input
              value={form.phone}
              onChange={(e) =>
                setForm((f) => ({ ...f, phone: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label>角色</Label>
            <select
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={form.role}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  role: e.target.value as "user" | "admin",
                }))
              }
            >
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? "创建中…" : "确认创建"}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
