"use client"

/**
 * 路线 A 教练控件 —— 开关 + 模型下拉
 */

import type { AIModel } from "@/types"

interface CoachControlsProps {
  enabled: boolean
  onEnabledChange: (v: boolean) => void
  models: AIModel[]
  modelRowId: string
  onModelChange: (id: string) => void
  modelsLoading: boolean
}

/** LLM 教练选择区 */
export function CoachControls(props: CoachControlsProps): React.JSX.Element {
  const {
    enabled,
    onEnabledChange,
    models,
    modelRowId,
    onModelChange,
    modelsLoading,
  } = props
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/30 px-3 py-2 space-y-2">
      <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        LLM 教练进化（路线 A）
      </label>
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        不勾选：纯遗传规划。勾选后由模型建议种群/代数/变异等，再跑 GP；不直接写公式。
      </p>
      {enabled && (
        <div className="space-y-1">
          <div className="text-[10px] text-[var(--text-muted)]">选择模型</div>
          {modelsLoading ? (
            <div className="text-[11px] text-[var(--text-muted)]">加载模型…</div>
          ) : models.length === 0 ? (
            <div className="text-[11px] text-amber-400/90">
              暂无模型，请先到 AI 设置添加渠道与模型。
            </div>
          ) : (
            <select
              value={modelRowId}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-primary)] px-2"
            >
              <option value="">请选择…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                  {m.provider_name ? ` · ${m.provider_name}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  )
}
