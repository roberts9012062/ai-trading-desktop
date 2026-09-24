"use client"

/**
 * 工具列表单行 —— 启用开关 + 可选自由交易开关
 */

import { cn } from "@/lib/utils"
import type { AIToolItem } from "@/lib/api"

/** 单个开关按钮 */
export function ToggleSwitch(props: {
  checked: boolean
  disabled: boolean
  title: string
  onClick: () => void
  accent: "info" | "warn"
}): React.JSX.Element {
  const { checked, disabled, title, onClick, accent } = props
  const onColor =
    accent === "warn"
      ? "bg-[var(--accent-warn)]"
      : "bg-[var(--accent-info)]"
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "relative shrink-0 w-10 h-5 rounded-full transition-colors",
        checked
          ? onColor
          : "bg-[var(--bg-tertiary)] border border-[var(--border)]",
        disabled && "opacity-50"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-[18px]"
        )}
      />
    </button>
  )
}

/** 单个工具行 */
export function ToolRow(props: {
  tool: AIToolItem
  toggling: string | null
  onToggleEnabled: (tool: AIToolItem) => void
  onToggleFreeTrade: (tool: AIToolItem) => void
}): React.JSX.Element {
  const { tool, toggling, onToggleEnabled, onToggleFreeTrade } = props
  const busy =
    toggling === `${tool.name}:enabled` ||
    toggling === `${tool.name}:free_trade`
  const supportsFree = Boolean(tool.supports_free_trade)

  return (
    <li
      className={cn(
        "rounded-lg border border-[var(--border)] px-4 py-3 bg-[var(--bg-primary)]/40",
        !tool.enabled && "opacity-60"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {tool.name_zh}
            </span>
            {supportsFree && tool.free_trade ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]">
                自由交易
              </span>
            ) : tool.requires_confirmation ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]">
                需确认
              </span>
            ) : null}
            <span
              className={cn(
                "text-[9px] px-1.5 py-0.5 rounded",
                tool.enabled
                  ? "bg-[var(--accent-up)]/15 text-[var(--accent-up)]"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
              )}
            >
              {tool.enabled ? "已启用" : "已关闭"}
            </span>
          </div>
          <p className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed">
            {tool.description_zh}
          </p>
          <p className="text-[10px] font-mono text-[var(--text-muted)]/70 mt-1.5">
            {tool.name}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-muted)] w-10 text-right">
              启用
            </span>
            <ToggleSwitch
              checked={tool.enabled}
              disabled={busy}
              title={
                tool.enabled ? "点击关闭（AI 将无法使用）" : "点击启用"
              }
              onClick={() => onToggleEnabled(tool)}
              accent="info"
            />
          </div>
          {supportsFree && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-muted)] w-10 text-right">
                自由
              </span>
              <ToggleSwitch
                checked={tool.free_trade}
                disabled={busy || !tool.enabled}
                title={
                  tool.free_trade
                    ? "关闭自由交易：执行前需用户确认"
                    : "开启自由交易：无需确认直接下单/撤单"
                }
                onClick={() => onToggleFreeTrade(tool)}
                accent="warn"
              />
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
