"use client"

/**
 * 路线 B：LLM 直接生成因子
 */

import { useState } from "react"
import type { AIModel } from "@/types"

interface GeneratePanelProps {
  models: AIModel[]
  modelsLoading: boolean
  loading: boolean
  onGenerate: (payload: {
    model_row_id: string
    user_hint: string
  }) => void
}

/** LLM 生成入口 */
export function GeneratePanel(props: GeneratePanelProps): React.JSX.Element {
  const { models, modelsLoading, loading, onGenerate } = props
  const [modelRowId, setModelRowId] = useState("")
  const [hint, setHint] = useState("")

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <h2 className="text-sm font-medium text-[var(--text-secondary)]">
        LLM 生成因子（路线 B）
      </h2>
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        由模型直接给出可执行 token 候选，经 StackVM 校验与评估后入库。与 GP
        搜索独立。
      </p>
      {modelsLoading ? (
        <div className="text-[11px] text-[var(--text-muted)]">加载模型…</div>
      ) : (
        <select
          value={modelRowId}
          onChange={(e) => setModelRowId(e.target.value)}
          className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] text-xs px-2"
        >
          <option value="">选择模型…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
              {m.provider_name ? ` · ${m.provider_name}` : ""}
            </option>
          ))}
        </select>
      )}
      <input
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        placeholder="可选提示，如：偏趋势、降低换手"
        className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] text-xs px-2"
      />
      <button
        type="button"
        disabled={loading || !modelRowId}
        onClick={() =>
          onGenerate({ model_row_id: modelRowId, user_hint: hint.trim() })
        }
        className="text-[11px] px-2.5 py-1.5 rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)] disabled:opacity-50"
      >
        {loading ? "生成中…" : "开始生成"}
      </button>
    </div>
  )
}
