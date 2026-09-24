"use client"

/**
 * 多品种调研子代理状态列表
 */

import type { SubAgentItem, SubAgentRunStatus } from "@/types"

const STATUS_STYLE: Record<SubAgentRunStatus, string> = {
  pending: "bg-zinc-500/15 text-zinc-400",
  running: "bg-sky-500/15 text-sky-400",
  done: "bg-emerald-500/15 text-emerald-400",
  error: "bg-red-500/15 text-red-400",
}

const STATUS_LABEL: Record<SubAgentRunStatus, string> = {
  pending: "等待中",
  running: "调研中",
  done: "已完成",
  error: "失败",
}

function statusIcon(status: SubAgentRunStatus): string {
  if (status === "running") return "⏳"
  if (status === "done") return "✅"
  if (status === "error") return "❌"
  return "○"
}

export function SubAgentList({
  agents,
}: {
  agents: SubAgentItem[]
}): React.JSX.Element | null {
  if (!agents || agents.length === 0) return null

  const running = agents.filter((a) => a.status === "running").length
  const done = agents.filter((a) => a.status === "done").length
  const failed = agents.filter((a) => a.status === "error").length

  return (
    <div className="my-2 rounded border border-[var(--border)] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text-primary)]">子代理调研</span>
        <span>
          {done}/{agents.length} 完成
          {running > 0 ? ` · ${running} 进行中` : ""}
          {failed > 0 ? ` · ${failed} 失败` : ""}
        </span>
      </div>
      <ul className="max-h-48 overflow-y-auto divide-y divide-[var(--border)]">
        {agents.map((agent) => (
          <li
            key={agent.id}
            className="flex items-start gap-2 px-2 py-1.5 text-[11px]"
          >
            <span className="mt-0.5 shrink-0" aria-hidden>
              {statusIcon(agent.status)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[var(--text-primary)] truncate">
                  {agent.name}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_STYLE[agent.status]}`}
                >
                  {STATUS_LABEL[agent.status]}
                </span>
                {agent.status === "running" ? (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                ) : null}
              </div>
              {agent.detail ? (
                <div className="text-[var(--text-muted)] mt-0.5 truncate">
                  {agent.detail}
                </div>
              ) : null}
              {typeof agent.progress === "number" &&
              agent.status === "running" ? (
                <div className="mt-1 h-1 rounded bg-[var(--bg-primary)] overflow-hidden">
                  <div
                    className="h-full bg-sky-500/70 transition-all"
                    style={{
                      width: `${Math.round(Math.min(1, Math.max(0, agent.progress)) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
