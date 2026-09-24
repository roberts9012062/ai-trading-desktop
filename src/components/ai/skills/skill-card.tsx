"use client"

import { useState } from "react"
import { Download, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { MarketplaceSkillItem } from "@/types"
import { installSkillFromMarketplace } from "@/lib/api"
import { showAlert } from "@/stores/dialog"

interface SkillCardProps {
  skill: MarketplaceSkillItem
  onInstalled: () => void
}

/** 商城 skill 卡片组件 */
export function SkillCard({ skill, onInstalled }: SkillCardProps): React.JSX.Element {
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)

  async function handleInstall(): Promise<void> {
    setInstalling(true)
    try {
      await installSkillFromMarketplace(skill.id)
      setInstalled(true)
      onInstalled()
    } catch (err) {
      await showAlert({ title: "安装失败", description: err instanceof Error ? err.message : "安装失败", variant: "destructive" })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Card className="hover:border-[var(--primary)]/30 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm truncate">{skill.name}</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">by {skill.author}</p>
            <p className="text-xs text-[var(--text-secondary)] mt-2 line-clamp-2">{skill.description}</p>
            <div className="flex items-center gap-3 mt-2 text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <Download className="w-3 h-3" />
                {skill.install_count}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-[var(--secondary)] text-[var(--text-muted)]">
                {skill.trigger_word}
              </span>
            </div>
          </div>
          <Button
            size="sm"
            variant={installed ? "secondary" : "default"}
            disabled={installing || installed}
            onClick={handleInstall}
          >
            {installed ? "已安装" : installing ? "安装中..." : "安装"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
