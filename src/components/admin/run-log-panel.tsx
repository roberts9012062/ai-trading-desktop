"use client"

/**
 * 任务运行日志面板（admin 用户详情 / 可复用）
 * 信号/下单/异常事件流：级别过滤 + 事件过滤 + 任务选择 + 10s 轮询。
 * factor 任务在 detail.factor 携带组合仓位快照（展开行显示）。
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getAdminUserRunLogsApi, type AdminRunLog } from "@/lib/admin-api"
import { downloadAuthenticatedFile } from "@/lib/download"

const EVENTS = ["", "signal", "order", "hard_rule", "session_close", "error"]
const LEVELS = ["", "info", "warn", "error"]

function fmtTime(iso: unknown): string {
  if (!iso || typeof iso !== "string") return "-"
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false })
  } catch {
    return String(iso)
  }
}

function LevelBadge({ level }: { level: string }) {
  const cls =
    level === "error"
      ? "text-down"
      : level === "warn"
        ? "text-amber-500"
        : "text-[var(--text-muted)]"
  return (
    <span className={`text-[11px] font-medium ${cls}`}>{level.toUpperCase()}</span>
  )
}

function FactorSnapshot({ detail }: { detail: Record<string, unknown> | null }) {
  const factor = detail?.factor as Record<string, unknown> | undefined
  if (!factor) return null
  const signal = factor.signal as Record<string, unknown> | undefined
  return (
    <div className="text-[11px] text-[var(--text-muted)] space-y-0.5">
      {signal && (
        <div>
          因子仓位：<span className="font-num">{String(signal.position ?? "-")}</span>
          <span className="ml-2 truncate inline-block max-w-[280px]">
            {String(signal.text ?? "")}
          </span>
        </div>
      )}
      {factor.tokens != null && (
        <div className="truncate max-w-[400px]">
          tokens: {JSON.stringify(factor.tokens)}
        </div>
      )}
      {factor.weights != null && (
        <div>权重: {JSON.stringify(factor.weights)}</div>
      )}
    </div>
  )
}

interface RunLogPanelProps {
  userId: string
  tasks: Record<string, unknown>[]
  tradingMode: string
  /** 预选任务（从 /admin/ai 跳转时） */
  presetTaskId?: string
}

export function RunLogPanel({
  userId,
  tasks,
  tradingMode,
  presetTaskId,
}: RunLogPanelProps) {
  const [taskId, setTaskId] = useState(presetTaskId ?? "")
  const [level, setLevel] = useState("")
  const [event, setEvent] = useState("")
  const [rows, setRows] = useState<AdminRunLog[]>([])
  const [total, setTotal] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await getAdminUserRunLogsApi(userId, {
        taskId: taskId || undefined,
        level: level || undefined,
        event: event || undefined,
        tradingMode: tradingMode as "live" | "virtual",
      })
      setRows(r.items ?? [])
      setTotal(r.total ?? 0)
    } catch {
      /* 轮询失败静默 */
    }
  }, [userId, taskId, level, event, tradingMode])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [load])

  const taskName = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of tasks) {
      m.set(String(t.id), String(t.name || t.symbol || t.id))
    }
    return m
  }, [tasks])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <select
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
        >
          <option value="">全部任务</option>
          {tasks.map((t) => (
            <option key={String(t.id)} value={String(t.id)}>
              {String(t.name || t.symbol || t.id)}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l || "全部级别"}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2"
          value={event}
          onChange={(e) => setEvent(e.target.value)}
        >
          {EVENTS.map((e) => (
            <option key={e} value={e}>
              {e || "全部事件"}
            </option>
          ))}
        </select>
        <span className="text-[var(--text-muted)]">
          共 {total} 条（10s 自动刷新）
        </span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          刷新
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void downloadAuthenticatedFile(
              `/api/admin/users/${userId}/run-logs/export?format=csv&trading_mode=${tradingMode}` +
                (taskId ? `&task_id=${taskId}` : "") +
                (level ? `&level=${level}` : "") +
                (event ? `&event=${event}` : ""),
              "run_logs.csv",
            ).catch(() => undefined)
          }
        >
          导出 CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void downloadAuthenticatedFile(
              `/api/admin/users/${userId}/run-logs/export?format=json&trading_mode=${tradingMode}` +
                (taskId ? `&task_id=${taskId}` : ""),
              "run_logs.json",
            ).catch(() => undefined)
          }
        >
          导出 JSON
        </Button>
      </div>
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>级别</TableHead>
              <TableHead>事件</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>合约/任务</TableHead>
              <TableHead>原因</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-xs text-[var(--text-muted)] py-6"
                >
                  暂无运行日志（任务产生信号后自动记录）
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() =>
                  setExpanded(expanded === r.id ? null : r.id)
                }
              >
                <TableCell className="text-xs font-num whitespace-nowrap">
                  {fmtTime(r.created_at)}
                </TableCell>
                <TableCell>
                  <LevelBadge level={r.level} />
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.event}</Badge>
                </TableCell>
                <TableCell className="text-xs">{r.action || "-"}</TableCell>
                <TableCell className="text-xs">
                  <div>{r.symbol}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {taskName.get(r.task_id) ?? r.strategy_type}
                  </div>
                </TableCell>
                <TableCell className="text-xs max-w-sm">
                  <div className="truncate">{r.reason || "-"}</div>
                  {expanded === r.id && (
                    <div className="mt-1 space-y-1">
                      <FactorSnapshot detail={r.detail} />
                      {r.order_id && (
                        <div className="text-[10px]">
                          委托: <span className="font-num">{r.order_id}</span>
                        </div>
                      )}
                      {r.detail && (
                        <pre className="text-[10px] whitespace-pre-wrap break-all max-h-48 overflow-auto rounded bg-[var(--bg-tertiary)] p-2">
                          {JSON.stringify(r.detail, null, 1)}
                        </pre>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
