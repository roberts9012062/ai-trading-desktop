"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown, Settings, Wrench, Eye, Brain, Scale } from "lucide-react"
import { useAISettingsStore } from "@/stores/ai-settings"
import { useAIChatStore } from "@/stores/ai-chat"
import type { AIModel } from "@/types"

/** 能力图标映射 */
function CapabilityIcon({ cap }: { cap: string }) {
  switch (cap) {
    case "tool_calling":
      return <span title="工具调用"><Wrench size={10} className="text-blue-400" /></span>
    case "vision":
      return <span title="多模态"><Eye size={10} className="text-purple-400" /></span>
    case "thinking":
      return <span title="思考"><Brain size={10} className="text-orange-400" /></span>
    case "decision":
      return <span title="决策（System One，不支持对话）"><Scale size={10} className="text-teal-400" /></span>
    default:
      return null
  }
}

/** 模型选择器下拉框 */
export function ModelSelector(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const models = useAISettingsStore((s) => s.models)
  const selectedModel = useAIChatStore((s) => s.selectedModel)
  const selectModel = useAIChatStore((s) => s.selectModel)
  const restoreModel = useAIChatStore((s) => s.restoreModel)

  // 初始化恢复模型选择
  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      restoreModel(models)
    }
  }, [models, selectedModel, restoreModel])

  // 点击外部关闭
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  // 模型库为空
  if (models.length === 0) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-[var(--text-muted)]">
        <span>请先在</span>
        <a
          href="/ai-settings"
          className="text-[var(--accent-info)] hover:underline flex items-center gap-1"
        >
          <Settings size={10} />
          AI 设置
        </a>
        <span>中添加模型</span>
      </div>
    )
  }

  function handleSelect(model: AIModel) {
    selectModel(model)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-[var(--bg-tertiary)] transition-colors max-w-[200px]"
      >
        <span className="truncate text-[var(--text-primary)]">
          {selectedModel?.display_name ?? "选择模型"}
        </span>
        <ChevronDown size={12} className={`text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg z-50">
          {models.map((model) => (
            <button
              key={model.id}
              onClick={() => handleSelect(model)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--bg-tertiary)] transition-colors ${
                selectedModel?.model_id === model.model_id ? "bg-[var(--bg-tertiary)]" : ""
              }`}
            >
              <span className="flex-1 truncate">
                <span className="text-[var(--text-primary)]">{model.display_name}</span>
                <span className="text-[var(--text-muted)] ml-1 text-[10px]">{model.provider_name}</span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                {(model.capabilities ?? []).map((cap: string) => (
                  <CapabilityIcon key={cap} cap={cap} />
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
