"use client"

/** K 线修正任务组管理 —— 状态聚合 / 启停 / 手动触发 / 任务级日志 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  PauseCircle,
  PlayCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react"
import {
  getKlineTaskLogsApi,
  getKlineTasksApi,
  pauseKlineTaskApi,
  resumeKlineTaskApi,
  runKlineTaskApi,
  type KlineTask,
  type KlineTaskLogsResponse,
} from "@/lib/admin-api"
import { cn } from "@/lib/utils"

type Health = "green" | "yellow" | "red" | "gray"

function taskHealth(t: KlineTask): Health {
  if (t.paused || t.status?.paused) return "yellow"
  if (t.status?.disabled) return "gray"
  if (t.status?.last_error) return "red"
  if (!t.status || Object.keys(t.status).length === 0) return "gray"
  return "green"
}

const HEALTH_STYLE: Record<Health, { dot: string; text: string }> = {
  green: { dot: "bg-emerald-500", text: "text-emerald-500" },
  yellow: { dot: "bg-amber-500", text: "text-amber-500" },
  red: { dot: "bg-red-500", text: "text-red-500" },
  gray: { dot: "bg-gray-400", text: "text-gray-400" },
}

function healthLabel(t: KlineTask): string {
  switch (taskHealth(t)) {
    case "yellow":
      return "已暂停"
    case "red":
      return "有错误"
    case "gray":
      return t.status?.disabled ? "本机禁用" : "未运行"
    default:
      return t.status?.running ? "运行中" : "正常"
  }
}

/** 结果摘要:各任务常见 stats 字段取一两个关键值 */
function statsSummary(t: KlineTask): string {
  const s = t.status ?? {}
  if (s.last_error) return `错误: ${s.last_error}`
  const parts: string[] = []
  if (typeof s.last_corrected === "number") parts.push(`修正 ${s.last_corrected} 桶`)
  if (typeof s.last_written === "number") parts.push(`写入 ${s.last_written} 行`)
  const st = s.last_stats as Record<string, unknown> | undefined
  if (st && typeof st === "object") {
    for (const key of ["candidates", "backfilled", "written_rows"]) {
      if (typeof st[key] === "number") {
        const label = key === "candidates" ? "候选" : key === "backfilled" ? "回填" : "行"
        parts.push(`${label} ${st[key]}`)
      }
    }
  }
  if (s.trigger) parts.push(`触发 ${s.trigger}`)
  return parts.join(" · ") || "-"
}

export default function KlineTasksPage(): React.JSX.Element {
  const [tasks, setTasks] = useState<KlineTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<string>("")
  const [expanded, setExpanded] = useState<string>("")
  const [logsByTask, setLogsByTask] = useState<Record<string, KlineTaskLogsResponse>>({})
  const tasksRef = useRef<KlineTask[]>([])

  const refresh = useCallback(async () => {
    try {
      const data = await getKlineTasksApi()
      tasksRef.current = data.tasks
      setTasks(data.tasks)
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshLogs = useCallback(async (name: string) => {
    try {
      const data = await getKlineTaskLogsApi(name)
      setLogsByTask((prev) => ({ ...prev, [name]: data }))
    } catch {
      /* 日志拉取失败静默,下轮重试 */
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (expanded) refreshLogs(expanded)
    const timer = setInterval(() => {
      if (expanded) refreshLogs(expanded)
    }, 10_000)
    return () => clearInterval(timer)
  }, [expanded, refreshLogs])

  const act = async (name: string, fn: (n: string) => Promise<void>) => {
    setBusy(name)
    try {
      await fn(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            K 线修正任务
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            权威修正 / 盘中对账 / 升级对账 / tickdata 同步与缺口回填 · 10 秒自动刷新
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm"
        >
          <RefreshCw className="w-4 h-4" /> 刷新
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium">任务</th>
              <th className="px-4 py-2 font-medium">节奏</th>
              <th className="px-4 py-2 font-medium">上次开始</th>
              <th className="px-4 py-2 font-medium">结果</th>
              <th className="px-4 py-2 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中…
                </td>
              </tr>
            )}
            {!loading &&
              tasks.map((t) => {
                const h = taskHealth(t)
                const isOpen = expanded === t.name
                return (
                  <>
                    <tr
                      key={t.name}
                      className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-tertiary)]/40 cursor-pointer"
                      onClick={() => setExpanded(isOpen ? "" : t.name)}
                    >
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className={cn("w-2 h-2 rounded-full", HEALTH_STYLE[h].dot)} />
                          <span className={cn("text-xs", HEALTH_STYLE[h].text)}>
                            {healthLabel(t)}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-primary)]">
                        <span className="inline-flex items-center gap-1.5">
                          {isOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                          )}
                          {t.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                        {t.interval_desc}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-secondary)] tabular-nums">
                        {t.status?.last_start ?? t.status?.last_done ?? "-"}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-secondary)] max-w-[22rem] truncate">
                        {statsSummary(t)}
                      </td>
                      <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                        {t.runnable && (
                          <button
                            type="button"
                            disabled={busy === t.name}
                            onClick={(e) => {
                              e.stopPropagation()
                              act(t.name, runKlineTaskApi)
                            }}
                            className="px-2.5 py-1 rounded bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                          >
                            立即运行
                          </button>
                        )}
                        {t.pausable && (
                          <button
                            type="button"
                            disabled={busy === t.name}
                            onClick={(e) => {
                              e.stopPropagation()
                              act(t.name, t.paused ? resumeKlineTaskApi : pauseKlineTaskApi)
                            }}
                            className="px-2 py-1 rounded bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 inline-flex items-center gap-1"
                          >
                            {t.paused ? (
                              <>
                                <PlayCircle className="w-3.5 h-3.5" /> 恢复
                              </>
                            ) : (
                              <>
                                <PauseCircle className="w-3.5 h-3.5" /> 暂停
                              </>
                            )}
                          </button>
                        )}
                        {!t.pausable && !t.runnable && (
                          <span className="text-xs text-[var(--text-muted)]">自动</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${t.name}-logs`} className="border-b border-[var(--border)]/50">
                        <td colSpan={6} className="px-4 py-3 bg-[var(--bg-primary)]/40">
                          <div className="text-xs text-[var(--text-muted)] mb-2">
                            任务日志(最新在前,保留 200 条)
                          </div>
                          <div className="max-h-64 overflow-auto rounded bg-[var(--bg-primary)] border border-[var(--border)]">
                            {(logsByTask[t.name]?.logs ?? []).length === 0 && (
                              <div className="px-3 py-4 text-xs text-[var(--text-muted)]">
                                暂无日志
                              </div>
                            )}
                            {(logsByTask[t.name]?.logs ?? []).map((l, i) => (
                              <div
                                key={i}
                                className="px-3 py-1.5 text-xs border-b border-[var(--border)]/40 last:border-0 flex gap-3"
                              >
                                <span className="text-[var(--text-muted)] tabular-nums shrink-0">
                                  {String(l.ts ?? "")}
                                </span>
                                <span
                                  className={cn(
                                    "shrink-0 w-12",
                                    l.level === "error"
                                      ? "text-red-400"
                                      : l.level === "warn"
                                        ? "text-amber-400"
                                        : "text-emerald-400",
                                  )}
                                >
                                  {String(l.level ?? "info")}
                                </span>
                                <span className="text-[var(--text-secondary)] break-all">
                                  {String(l.msg ?? "")}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
