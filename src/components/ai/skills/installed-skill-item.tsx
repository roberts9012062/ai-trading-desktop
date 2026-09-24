"use client"

import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { InstalledSkillItem } from "@/types"
import { showConfirm } from "@/stores/dialog"

interface InstalledSkillItemProps {
  skill: InstalledSkillItem
  onToggle: (id: string) => void
  onUninstall: (id: string) => void
}

/** 已安装 skill 列表项 */
export function InstalledSkillItemRow({ skill, onToggle, onUninstall }: InstalledSkillItemProps): React.JSX.Element {
  const sourceLabel: Record<string, string> = {
    marketplace: "商城",
    upload: "手动上传",
    git_url: "Git URL",
  }

  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-[var(--border)] hover:border-[var(--primary)]/20 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium truncate">{skill.name}</h4>
          <span className="px-1.5 py-0.5 rounded text-xs bg-[var(--secondary)] text-[var(--text-muted)]">
            {skill.trigger_word}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {sourceLabel[skill.source] ?? skill.source}
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-1 truncate">{skill.description}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* 启用/禁用开关 */}
        <button
          onClick={() => onToggle(skill.id)}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            skill.is_enabled ? "bg-[var(--primary)]" : "bg-[var(--text-muted)]/30"
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              skill.is_enabled ? "left-5" : "left-0.5"
            }`}
          />
        </button>

        {/* 卸载按钮 */}
        <Button
          size="sm"
          variant="ghost"
          className="text-[var(--destructive)] hover:text-[var(--destructive)]"
          onClick={async () => {
            if (await showConfirm({ title: "卸载技能", description: `确定卸载 ${skill.name}？`, variant: "destructive", confirmText: "卸载" })) {
              onUninstall(skill.id)
            }
          }}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}
