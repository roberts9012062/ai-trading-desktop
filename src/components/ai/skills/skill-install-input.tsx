"use client"

import { useState } from "react"
import { Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { installSkillFromGit } from "@/lib/api"
import { showAlert } from "@/stores/dialog"

/** 安装指令输入框组件 */
export function SkillInstallInput({ onSuccess }: { onSuccess: () => void }): React.JSX.Element {
  const [value, setValue] = useState("")
  const [installing, setInstalling] = useState(false)

  async function handleInstall(): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) return

    setInstalling(true)
    try {
      await installSkillFromGit(trimmed)
      setValue("")
      onSuccess()
    } catch (err) {
      await showAlert({ title: "安装失败", description: err instanceof Error ? err.message : "安装失败", variant: "destructive" })
    } finally {
      setInstalling(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter" && !installing) {
      handleInstall()
    }
  }

  return (
    <div className="flex items-center gap-2 p-3 rounded-lg border border-[var(--border)]">
      <Terminal className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
      <Input
        placeholder="粘贴安装指令，如 /install github.com/user/skill-name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1"
      />
      <Button size="sm" onClick={handleInstall} disabled={installing || !value.trim()}>
        {installing ? "安装中..." : "安装"}
      </Button>
    </div>
  )
}
