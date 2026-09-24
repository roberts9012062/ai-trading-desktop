"use client"

import { useState, useEffect } from "react"
import { Settings, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { showAlert, showConfirm } from "@/stores/dialog"
import { Input } from "@/components/ui/input"
import { getSkillConfig, updateSkillConfig, deleteSkillConfig } from "@/lib/api"

/** Skills.sh Token 配置弹窗 */
export function SkillConfigDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [maskedToken, setMaskedToken] = useState("")
  const [hasToken, setHasToken] = useState(false)
  const [newToken, setNewToken] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      loadConfig()
    }
  }, [open])

  async function loadConfig(): Promise<void> {
    try {
      const config = await getSkillConfig()
      setHasToken(config.has_token)
      setMaskedToken(config.masked_token)
    } catch {
      setHasToken(false)
      setMaskedToken("")
    }
  }

  async function handleSave(): Promise<void> {
    if (!newToken.trim()) return
    setSaving(true)
    try {
      const result = await updateSkillConfig(newToken.trim())
      setHasToken(result.has_token)
      setMaskedToken(result.masked_token)
      setNewToken("")
    } catch (err) {
      await showAlert({
        title: "保存失败",
        description: err instanceof Error ? err.message : "保存失败",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!(await showConfirm({
      title: "删除 Token",
      description: "确定删除已配置的 Token？",
      variant: "destructive",
    }))) return
    setSaving(true)
    try {
      await deleteSkillConfig()
      setHasToken(false)
      setMaskedToken("")
      setNewToken("")
    } catch (err) {
      await showAlert({
        title: "删除失败",
        description: err instanceof Error ? err.message : "删除失败",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="text-[var(--text-muted)]">
          <Settings className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Skills.sh 配置</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 当前 token 状态 */}
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">当前 Token</label>
            {hasToken ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2">
                  {maskedToken}
                </code>
                <Button size="sm" variant="ghost" className="text-[var(--destructive)]" onClick={handleDelete} disabled={saving}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">未配置 Token（使用公开 API，可能有速率限制）</p>
            )}
          </div>

          {/* 输入新 token */}
          <div className="space-y-2">
            <label className="text-xs text-[var(--text-muted)]">
              {hasToken ? "更新 Token" : "输入 Token"}
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder="skills.sh API Token"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                className="flex-1"
              />
              <Button size="sm" onClick={handleSave} disabled={saving || !newToken.trim()}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              从 <a href="https://skills.sh" target="_blank" rel="noopener noreferrer" className="text-[var(--primary)] underline">skills.sh</a> 获取你的 API Token
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
