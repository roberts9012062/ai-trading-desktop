"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { RefreshCw, Eye } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  getAdminUserAiTasksApi,
  listAdminUsersApi,
  type AdminTradingMode,
  type AdminUserItem,
} from "@/lib/admin-api"

interface UserAiRow {
  user: AdminUserItem
  running: number
  total: number
  cashDeltaSum: number
  loading: boolean
}

function money(v: number): string {
  return `¥${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function modeEquity(user: AdminUserItem, mode: AdminTradingMode): number {
  if (mode === "virtual") {
    return Number(user.virtual_equity ?? 0)
  }
  return Number(user.live_equity ?? user.total_equity ?? 0)
}

/** AI 监管总览 —— 实盘 / 虚拟盘分 Tab，按 trading_mode 隔离 */
export default function AdminAiPage(): React.JSX.Element {
  const [tradingMode, setTradingMode] = useState<AdminTradingMode>("live")
  const [rows, setRows] = useState<UserAiRow[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const usersRes = await listAdminUsersApi({
        status: "all",
        limit: 100,
        offset: 0,
      })
      const base: UserAiRow[] = usersRes.items.map((u) => ({
        user: u,
        running: 0,
        total: 0,
        cashDeltaSum: 0,
        loading: true,
      }))
      setRows(base)

      const detailed = await Promise.all(
        usersRes.items.map(async (u) => {
          try {
            const tasks = await getAdminUserAiTasksApi(u.id, tradingMode)
            const running = tasks.items.filter(
              (t) => t.status === "running",
            ).length
            const cashDeltaSum = tasks.items.reduce(
              (sum, t) => sum + Number(t.cash_delta ?? 0),
              0,
            )
            return {
              user: u,
              running,
              total: tasks.total,
              cashDeltaSum,
              loading: false,
            } satisfies UserAiRow
          } catch {
            return {
              user: u,
              running: 0,
              total: 0,
              cashDeltaSum: 0,
              loading: false,
            } satisfies UserAiRow
          }
        }),
      )
      detailed.sort((a, b) => b.total - a.total || b.running - a.running)
      setRows(detailed)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [tradingMode])

  useEffect(() => {
    void load()
  }, [load])

  const totalRunning = rows.reduce((s, r) => s + r.running, 0)
  const totalTasks = rows.reduce((s, r) => s + r.total, 0)
  const withTasks = rows.filter((r) => r.total > 0).length
  const modeLabel = tradingMode === "live" ? "实盘数据" : "虚拟盘数据"

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          AI 监管
          <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
            {modeLabel}
          </span>
        </h1>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-xs">
            <button
              type="button"
              className={`px-3 py-1.5 rounded ${
                tradingMode === "live"
                  ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)]"
              }`}
              onClick={() => setTradingMode("live")}
            >
              实盘数据 AI
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 rounded ${
                tradingMode === "virtual"
                  ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)]"
              }`}
              onClick={() => setTradingMode("virtual")}
            >
              虚拟盘数据 AI
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </Button>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        当前仅统计「{modeLabel}」下的 AI/量化任务与对应模拟账户权益，两盘互不串。
      </p>

      {error && (
        <div className="px-4 py-2 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">
              运行中任务（{modeLabel}）
            </p>
            <p className="text-2xl font-num mt-1">{totalRunning}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">
              任务总数（{modeLabel}）
            </p>
            <p className="text-2xl font-num mt-1">{totalTasks}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">有 AI 任务的用户</p>
            <p className="text-2xl font-num mt-1">{withTasks}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>用户 AI 运行一览 · {modeLabel}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>任务数</TableHead>
                <TableHead>运行中</TableHead>
                <TableHead>权益差合计</TableHead>
                <TableHead>
                  {tradingMode === "live" ? "实盘权益" : "虚拟盘权益"}
                </TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-[var(--text-muted)]"
                  >
                    加载中…
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={`${tradingMode}-${r.user.id}`}>
                  <TableCell className="font-medium">
                    {r.user.username}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        r.user.status === "active" ? "up" : "destructive"
                      }
                    >
                      {r.user.status === "active" ? "正常" : "冻结"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-num">{r.total}</TableCell>
                  <TableCell className="font-num">
                    {r.running > 0 ? (
                      <span className="text-[var(--primary)] font-semibold">
                        {r.running}
                      </span>
                    ) : (
                      r.running
                    )}
                  </TableCell>
                  <TableCell className="font-num">
                    {money(r.cashDeltaSum)}
                  </TableCell>
                  <TableCell className="font-num">
                    {money(modeEquity(r.user, tradingMode))}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/users/${r.user.id}?mode=${tradingMode}&tab=runlogs`}
                    >
                      <Button variant="ghost" size="sm">
                        <Eye className="w-3.5 h-3.5" />
                        详情
                      </Button>
                    </Link>
                    <Link
                      href={`/admin/users/${r.user.id}?mode=${tradingMode}&tab=runlogs`}
                    >
                      <Button variant="outline" size="sm">
                        日志
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-[var(--text-muted)]"
                  >
                    暂无用户
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
