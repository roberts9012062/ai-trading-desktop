"use client"

import { useEffect, useState } from "react"
import {
  Settings,
  FileText,
  Brain,
  Sparkles,
  Store,
  Package,
  Wrench,
} from "lucide-react"
import Link from "next/link"
import { useAISettingsStore } from "@/stores/ai-settings"
import { ProviderPanel } from "@/components/ai-settings/provider-panel"
import { ModelPanel } from "@/components/ai-settings/model-panel"
import { KnowledgePanel } from "@/components/ai-settings/knowledge-panel"
import { MemoryPanel } from "@/components/ai-settings/memory-panel"
import { ToolsPanel } from "@/components/ai-settings/tools-panel"
import { cn } from "@/lib/utils"

type LeftTab = "provider" | "knowledge" | "memory" | "skills" | "tools"

const TABS: Array<{ key: LeftTab; label: string; icon: React.ReactNode }> = [
  { key: "provider", label: "渠道", icon: <Settings size={12} /> },
  { key: "knowledge", label: "知识库", icon: <FileText size={12} /> },
  { key: "memory", label: "记忆", icon: <Brain size={12} /> },
  { key: "skills", label: "Skills", icon: <Sparkles size={12} /> },
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
              onClick={() => setLeftTab(tab.key)}
              className={cn(
                "flex items-center justify-center gap-1 px-4 py-2.5 text-xs transition-colors",
                leftTab === tab.key
                  ? "text-[var(--accent-info)] border-b-2 border-[var(--accent-info)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              )}
            >
              {tab.icon} {tab.label}
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
              onClick={() => setLeftTab(tab.key)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 px-2 py-2.5 text-xs transition-colors",
                leftTab === tab.key
                  ? "text-[var(--accent-info)] border-b-2 border-[var(--accent-info)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              )}
            >
              {tab.icon} {tab.label}
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
          {leftTab === "knowledge" && <KnowledgePanel />}
          {leftTab === "memory" && <MemoryPanel />}
          {leftTab === "skills" && (
            <div className="p-4 space-y-3">
              <Link
                href="/ai/skills"
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <Store className="w-5 h-5 text-[var(--accent-info)] shrink-0" />
                <div>
                  <p className="text-sm font-medium">Skills 商城</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    发现并安装社区 AI Skills
                  </p>
                </div>
              </Link>
              <Link
                href="/ai/skills/installed"
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <Package className="w-5 h-5 text-[var(--accent-info)] shrink-0" />
                <div>
                  <p className="text-sm font-medium">我的 Skills</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    管理已安装的 Skills
                  </p>
                </div>
              </Link>
            </div>
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
