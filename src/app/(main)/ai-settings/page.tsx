"use client"

import { useEffect, useState } from "react"
import {
  Settings,
  FileText,
  Brain,
  Sparkles,
  Lock,
  Wrench,
} from "lucide-react"
import { useAISettingsStore } from "@/stores/ai-settings"
import { ProviderPanel } from "@/components/ai-settings/provider-panel"
import { ModelPanel } from "@/components/ai-settings/model-panel"
import { ToolsPanel } from "@/components/ai-settings/tools-panel"
import { cn } from "@/lib/utils"

type LeftTab = "provider" | "knowledge" | "memory" | "skills" | "tools"

const TABS: Array<{ key: LeftTab; label: string; icon: React.ReactNode; locked?: boolean }> = [
  { key: "provider", label: "渠道", icon: <Settings size={12} /> },
  { key: "knowledge", locked: true, label: "知识库", icon: <FileText size={12} /> },
  { key: "memory", locked: true, label: "记忆", icon: <Brain size={12} /> },
  { key: "skills", locked: true, label: "Skills", icon: <Sparkles size={12} /> },
  { key: "tools", label: "工具", icon: <Wrench size={12} /> },
]

/** AI 设置 —— 渠道/知识库/记忆/Skills/工具箱 */
export default function AISettingsPage(): React.JSX.Element {
  const { fetchProviders, fetchModels, testResults } = useAISettingsStore()
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null
  )
  const [leftTab, setLeftTab] = useState<LeftTab>("provider")

  useEffect(() => {
    fetchProviders()
    fetchModels()
  }, [fetchProviders, fetchModels])

  // 工具箱：整页左分类 + 右列表
  if (leftTab === "tools") {
    return (
      <div className="flex flex-col h-full">
        <div className="flex border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              disabled={tab.locked}
              title={tab.locked ? `${tab.label} · 待开发` : tab.label}
              onClick={() => !tab.locked && setLeftTab(tab.key)}
              className={cn(
                "flex items-center justify-center gap-1 px-4 py-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                leftTab === tab.key
                  ? "text-[var(--accent-info)] border-b-2 border-[var(--accent-info)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              )}
            >
              {tab.locked ? <Lock size={12} /> : tab.icon}
              <span>{tab.label}{tab.locked && <span className="block text-[9px]">待开发</span>}</span>
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0">
          <ToolsPanel />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="w-[320px] border-r border-[var(--border)] bg-[var(--bg-secondary)] flex flex-col">
        <div className="flex border-b border-[var(--border)]">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              disabled={tab.locked}
              title={tab.locked ? `${tab.label} · 待开发` : tab.label}
              onClick={() => !tab.locked && setLeftTab(tab.key)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 px-2 py-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                leftTab === tab.key
                  ? "text-[var(--accent-info)] border-b-2 border-[var(--accent-info)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              )}
            >
              {tab.locked ? <Lock size={12} /> : tab.icon}
              <span>{tab.label}{tab.locked && <span className="block text-[9px]">待开发</span>}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-hidden">
          {leftTab === "provider" && (
            <ProviderPanel
              onSelectProvider={setSelectedProviderId}
              selectedProviderId={selectedProviderId}
            />
          )}

        </div>
      </div>

      <div className="flex-1 bg-[var(--bg-secondary)]">
        <ModelPanel
          providerId={selectedProviderId}
          testResults={testResults}
        />
      </div>
    </div>
  )
}
