"use client"

import { Suspense, useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useSearchParams } from "next/navigation"
import { ArrowLeft, RefreshCw } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { UserDetailTabs } from "@/components/admin/user-detail-tabs"
import { UserQuotaCard } from "@/components/admin/user-quota-card"
import {
  getAdminUserAiDecisionsApi,
  getAdminUserAiTasksApi,
  getAdminUserOrdersApi,
  getAdminUserOverviewApi,
  getAdminUserPnlApi,
  getAdminUserPositionsApi,
  type AdminTradingMode,
  type AdminUserOverview,
} from "@/lib/admin-api"

function money(v: unknown): string {
  const n = Number(v ?? 0)
  return `¥${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function fmtTime(iso: unknown): string {
  if (!iso || typeof iso !== "string") return "-"
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false })
  } catch {
    return String(iso)
  }
}

function AdminUserDetailInner(): React.JSX.Element {
  const params = useParams()
  const searchParams = useSearchParams()
  const userId = String(params.id ?? "")
  const modeFromQuery = searchParams.get("mode")
  const initialMode: AdminTradingMode =
    modeFromQuery === "virtual" ? "virtual" : "live"
  const [tradingMode, setTradingMode] =
    useState<AdminTradingMode>(initialMode)
  const [overview, setOverview] = useState<AdminUserOverview | null>(null)
  const [orders, setOrders] = useState<Record<string, unknown>[]>([])
  const [positions, setPositions] = useState<Record<string, unknown>[]>([])
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([])
  const [decisions, setDecisions] = useState<Record<string, unknown>[]>([])
  const [pnl, setPnl] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (modeFromQuery === "virtual" || modeFromQuery === "live") {
      setTradingMode(modeFromQuery)
    }
  }, [modeFromQuery])

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError("")
    try {
      const [ov, ord, pos, tsk, dec, p] = await Promise.all([
        getAdminUserOverviewApi(userId, tradingMode),
        getAdminUserOrdersApi(userId, { limit: 50, tradingMode }),
        getAdminUserPositionsApi(userId, tradingMode),
        getAdminUserAiTasksApi(userId, tradingMode),
        getAdminUserAiDecisionsApi(userId, undefined, tradingMode),
        getAdminUserPnlApi(userId, tradingMode),
      ])
      setOverview(ov)
      setOrders(ord.items)
      setPositions(pos.items)
      setTasks(tsk.items)
      setDecisions(dec.items)
      setPnl(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [userId, tradingMode])

  useEffect(() => {
    void load()
  }, [load])

  const u = overview?.user
  const acc = overview?.paper_account ?? {}
  const stats = overview?.ai_task_stats

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link href="/admin/users">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4" />
              返回
            </Button>
          </Link>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            用户详情
            {u && (
              <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
                {u.username}
              </span>
            )}
          </h1>
        </div>
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
              实盘
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
              虚拟盘
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-[var(--text-muted)]">加载中…</p>}

      {!loading && u && (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            当前查看：
            <span className="text-[var(--text-secondary)]">
              {tradingMode === "live" ? "实盘数据" : "虚拟盘数据"}
            </span>
            （与用户登录所选盘一致的独立宇宙）
          </p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--text-muted)]">角色 / 状态</p>
                <div className="flex gap-2 mt-2">
                  <Badge variant="outline">
                    {u.role === "admin" ? "管理员" : "用户"}
                  </Badge>
                  <Badge
                    variant={u.status === "active" ? "up" : "destructive"}
                  >
                    {u.status === "active" ? "正常" : "冻结"}
                  </Badge>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-2">
                  注册 {fmtTime(u.created_at)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--text-muted)]">模拟权益</p>
                <p className="text-xl font-num mt-1">
                  {money(acc.total_equity)}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  可用 {money(acc.available_margin)} · 冻结{" "}
                  {money(acc.frozen_margin)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--text-muted)]">已实现盈亏</p>
                <p className="text-xl font-num mt-1">
                  {money(pnl?.paper_realized_pnl ?? acc.realized_pnl)}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  累计领取 {money(acc.total_claimed)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--text-muted)]">AI 任务</p>
                <p className="text-xl font-num mt-1">{stats?.total ?? 0}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  运行 {stats?.running ?? 0} · 暂停 {stats?.paused ?? 0} ·
                  结束 {stats?.stopped ?? 0}
                </p>
              </CardContent>
            </Card>
          </div>

          <UserQuotaCard userId={userId} />

          <UserDetailTabs
            orders={orders}
            positions={positions}
            tasks={tasks}
            decisions={decisions}
            pnl={pnl}
            userId={userId}
            tradingMode={tradingMode}
            defaultTab={searchParams.get("tab") ?? undefined}
          />
        </>
      )}
    </div>
  )
}

/** 用户详情：Suspense 包裹 useSearchParams（?mode=live|virtual） */
export default function AdminUserDetailPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-[var(--text-muted)]">加载中…</div>
      }
    >
      <AdminUserDetailInner />
    </Suspense>
  )
}
