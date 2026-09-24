"use client"

/** 能力标签 —— 工具调用（蓝色）、多模态（紫色）、思考（橙色）、决策（青色） */

const CAPABILITY_CONFIG: Record<string, { label: string; color: string }> = {
  tool_calling: { label: "工具调用", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  vision: { label: "多模态", color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
  thinking: { label: "思考", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  decision: { label: "决策", color: "bg-teal-500/20 text-teal-400 border-teal-500/30" },
}

interface CapabilityTagsProps {
  capabilities: string[]
}

export function CapabilityTags({ capabilities }: CapabilityTagsProps): React.JSX.Element {
  if (!capabilities || capabilities.length === 0) return <></>

  return (
    <div className="flex gap-1 flex-wrap">
      {capabilities.map((cap) => {
        const config = CAPABILITY_CONFIG[cap]
        if (!config) return null
        return (
          <span
            key={cap}
            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${config.color}`}
          >
            {config.label}
          </span>
        )
      })}
    </div>
  )
}
