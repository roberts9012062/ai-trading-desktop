"use client"

import { useState } from "react"
import { Copy, Download } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { MarketplaceSkillDetail } from "@/types"
import { installSkillFromMarketplace } from "@/lib/api"
import { showAlert } from "@/stores/dialog"

interface SkillDetailModalProps {
  skill: MarketplaceSkillDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled: () => void
}

/** Skill 详情弹窗 */
export function SkillDetailModal({ skill, open, onOpenChange, onInstalled }: SkillDetailModalProps): React.JSX.Element {
  const [installing, setInstalling] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!skill) return <></>

  const installCommand = skill.git_url
    ? `/install ${skill.git_url.replace(/\.git$/, "")}`
    : ""

  async function handleInstall(): Promise<void> {
    if (!skill) return
    setInstalling(true)
    try {
      await installSkillFromMarketplace(skill.id)
      onInstalled()
      onOpenChange(false)
    } catch (err) {
      await showAlert({ title: "安装失败", description: err instanceof Error ? err.message : "安装失败", variant: "destructive" })
    } finally {
      setInstalling(false)
    }
  }

  function handleCopy(): void {
    if (!installCommand) return
    navigator.clipboard.writeText(installCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg">{skill.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 基本信息 */}
          <div className="flex items-center gap-4 text-sm text-[var(--text-muted)]">
            <span>by {skill.author}</span>
            <span className="flex items-center gap-1">
              <Download className="w-3.5 h-3.5" />
              {skill.install_count} 次安装
            </span>
            <span className="px-2 py-0.5 rounded bg-[var(--secondary)] text-xs">
              {skill.trigger_word}
            </span>
          </div>

          {/* 描述 */}
          <p className="text-sm text-[var(--text-secondary)]">{skill.description}</p>

          {/* SKILL.md 预览 */}
          {skill.skill_md_preview && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">SKILL.md 预览</h4>
              <pre className="text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-md p-3 overflow-auto max-h-64 whitespace-pre-wrap">
                {skill.skill_md_preview.slice(0, 2000)}
              </pre>
            </div>
          )}

          {/* 安装指令 */}
          {installCommand && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">安装指令</h4>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2">
                  {installCommand}
                </code>
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button onClick={handleInstall} disabled={installing}>
              {installing ? "安装中..." : "安装此 Skill"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
