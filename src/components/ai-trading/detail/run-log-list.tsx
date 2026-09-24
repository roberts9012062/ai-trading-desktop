"use client"

/**
 * 任务运行日志列表（AI 交易详情抽屉用）
 * 信号/下单/异常事件流；factor 任务显示组合仓位快照列。
 */

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { listTaskRunLogs } from "@/lib/ai-trading-api"
import { downloadAuthenticatedFile } from "@/lib/download"

interface RunLogItem {
  id: string
  bar_time: string | null
  timeframe: string
  symbol: string
  strategy_type: string
  level: "info" | "warn" | "error"
  event: string
  action: string
  order_id: string | null
  reason: string
  detail: Record<string, unknown> | null
  created_at: string | null
}

interface RunLogListProps {
  taskId: string
  open: boolean
}

export function RunLogList({ taskId, open }: RunLogListProps) {
  const [rows, setRows] = useState<RunLogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!taskId) return
    setLoading(true)
    try {
      const r = await listTaskRunLogs(taskId, 100)
      setRows((r.items ?? []) as unknown as RunLogItem[])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void load()}>
          刷新
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void downloadAuthenticatedFile(
              `/api/ai-trading/tasks/${taskId}/run-logs/export?format=csv`,
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
              `/api/ai-trading/tasks/${taskId}/run-logs/export?format=json`,
              "run_logs.json",
            ).catch(() => undefined)
          }
        >
          导出 JSON
        </Button>
      </div>
      {loading && rows.length === 0 && (
        <div className="text-xs text-[var(--text-muted)] py-4 text-center">
          加载中…
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div className="text-xs text-[var(--text-muted)] py-4 text-center">
          暂无运行日志
        </div>
      )}
      <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] max-h-[420px] overflow-y-auto">
        {rows.map((r) => {
          const factor = (r.detail?.factor ?? {}) as Record<string, unknown>
          const signal = (factor.signal ?? {}) as Record<string, unknown>
          const isError = r.level === "error"
          return (
            <div
              key={r.id}
              className={`px-3 py-2 text-xs cursor-pointer hover:bg-[var(--bg-tertiary)] ${
                isError ? "text-down" : ""
              }`}
              onClick={() => setExpanded(expanded === r.id ? null : r.id)}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-num text-[var(--text-muted)]">
                  {r.created_at
                    ? new Date(r.created_at).toLocaleString("zh-CN", {
                        hour12: false,
                      })
                    : "-"}
                </span>
                <Badge variant="outline">{r.event}</Badge>
                {r.action && <span>{r.action}</span>}
                {signal.position != null && (
                  <span className="font-num">
                    因子仓位 {String(signal.position ?? "")}
                  </span>
                )}
                <span className="flex-1 truncate text-[var(--text-secondary)]">
                  {r.reason}
                </span>
              </div>
              {expanded === r.id && (
                <div className="mt-1 space-y-1">
                  {typeof signal.text === "string" && signal.text ? (
                    <div className="text-[10px] text-[var(--text-muted)]">
                      公式: {signal.text}
                    </div>
                  ) : null}
                  {factor.tokens != null && (
                    <div className="text-[10px] text-[var(--text-muted)] break-all">
                      tokens: {JSON.stringify(factor.tokens)}
                    </div>
                  )}
                  {r.order_id && (
                    <div className="text-[10px]">
                      委托: <span className="font-num">{r.order_id}</span>
                    </div>
                  )}
                  {r.detail && (
                    <pre className="text-[10px] whitespace-pre-wrap break-all max-h-40 overflow-auto rounded bg-[var(--bg-tertiary)] p-2">
                      {JSON.stringify(r.detail, null, 1)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
