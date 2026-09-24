"use client"

import { useState, useEffect, useCallback } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import { getInstalledSkills, toggleSkill, uninstallSkill } from "@/lib/api"
import { InstalledSkillItemRow } from "@/components/ai/skills/installed-skill-item"
import { SkillUpload } from "@/components/ai/skills/skill-upload"
import { SkillInstallInput } from "@/components/ai/skills/skill-install-input"
import { Button } from "@/components/ui/button"
import type { InstalledSkillItem } from "@/types"
import { showAlert } from "@/stores/dialog"
import Link from "next/link"

/** 已安装 Skills 管理页面 */
export default function InstalledSkillsPage(): React.JSX.Element {
  const [skills, setSkills] = useState<InstalledSkillItem[]>([])
  const [loading, setLoading] = useState(true)

  const loadSkills = useCallback(async () => {
    try {
      const items = await getInstalledSkills()
      setSkills(items)
    } catch {
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  async function handleToggle(id: string): Promise<void> {
    try {
      const updated = await toggleSkill(id)
      setSkills((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
    } catch (err) {
      await showAlert({ title: "操作失败", description: err instanceof Error ? err.message : "操作失败", variant: "destructive" })
    }
  }

  async function handleUninstall(id: string): Promise<void> {
    try {
      await uninstallSkill(id)
      setSkills((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      await showAlert({ title: "卸载失败", description: err instanceof Error ? err.message : "卸载失败", variant: "destructive" })
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 页头 */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--border)]">
        <Link href="/ai/skills">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">我的 Skills</h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">管理已安装的 AI Skills</p>
        </div>
      </div>

      {/* 安装指令输入 */}
      <div className="px-6 py-3 border-b border-[var(--border)]">
        <SkillInstallInput onSuccess={loadSkills} />
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {/* 上传区 */}
        <SkillUpload onSuccess={loadSkills} />

        {/* 已安装列表 */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-[var(--text-muted)]">
            已安装 ({skills.length})
          </h3>

          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : skills.length === 0 ? (
            <div className="text-center py-10 text-[var(--text-muted)] text-sm">
              暂无已安装的 Skills，去商城看看吧
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <InstalledSkillItemRow
                  key={skill.id}
                  skill={skill}
                  onToggle={handleToggle}
                  onUninstall={handleUninstall}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
