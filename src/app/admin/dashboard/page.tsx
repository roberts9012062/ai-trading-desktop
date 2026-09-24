"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
  Users,
  Bot,
  Activity,
  Server,
  Settings,
  UserPlus,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getAdminOverviewApi, type AdminOverview } from "@/lib/admin-api"

/** 渠道状态色：绿=正常 橙=不稳定 红=不能用 */
const STATUS_COLOR: Record<string, string> = {
  green: "var(--accent-down)",
  orange: "var(--accent-warn)",
  red: "var(--accent-danger)",
}
const STATUS_LABEL: Record<string, string> = {
  green: "正常",
  orange: "不稳定",
  red: "不能用",
}

function money(n: number | undefined): string {
  return `¥${Math.round(n ?? 0).toLocaleString()}`
}

/** 管理仪表盘 —— 渠道/系统/AI/用户资金四块聚合摘要（每 10s 刷新） */
export default function AdminDashboardPage(): React.JSX.Element {
  const [ov, setOv] = useState<AdminOverview | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        setOv(await getAdminOverviewApi())
        setError("")
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "加载失败")
        }
      }
    }
    void load()
    const t = setInterval(() => void load(), 10000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const channels = ov ? Object.entries(ov.channels.channels) : []
  const containers = ov ? Object.entries(ov.system.containers) : []

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">
        管理仪表盘
      </h1>

      {error && (
        <div className="px-4 py-2 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm">
          {error}
        </div>
      )}

      {/* 用户与资金 + AI 顶部指标 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">用户总数</p>
            <p className="text-2xl font-num">{ov?.users.total_users ?? "-"}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              今日新增 {ov?.users.today_new ?? "-"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">全平台总权益</p>
            <p className="text-2xl font-num">{money(ov?.users.total_equity)}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              live {money(ov?.users.by_mode?.live?.equity)} · virtual{" "}
              {money(ov?.users.by_mode?.virtual?.equity)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">AI 运行任务</p>
            <p className="text-2xl font-num">
              {ov?.ai.running ?? "-"}
              <span className="text-base text-[var(--text-muted)]">
                {" "}
                / {ov?.ai.total ?? "-"}
              </span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">AI 分配资金</p>
            <p className="text-2xl font-num">{money(ov?.ai.allocated_capital)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 行情渠道 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>行情渠道</CardTitle>
            <Link
              href="/admin/channels"
              className="text-xs text-[var(--primary)] hover:underline"
            >
              详情 →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-sm">
              当前生效：
              <span className="font-semibold">{ov?.channels.active ?? "-"}</span>
            </div>
            {channels.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">暂无探测数据</p>
            ) : (
              channels.map(([ch, h]) => (
                <div
                  key={ch}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: STATUS_COLOR[h.status] }}
                    />
                    {ch}
                    {ov?.channels.active === ch && (
                      <span className="text-[10px] text-[var(--primary)]">
                        生效
                      </span>
                    )}
                  </span>
                  <span style={{ color: STATUS_COLOR[h.status] }}>
                    {STATUS_LABEL[h.status] ?? h.status}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* 系统服务 */}
        <Card>
          <CardHeader className="space-y-0">
            <CardTitle>系统服务</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 text-sm">
            {containers.map(([name, status]) => {
              const short = name.replace("qihuo-", "")
              const ok = status === "running"
              return (
                <div
                  key={name}
                  className="flex items-center justify-between"
                >
                  <span className="text-[var(--text-muted)] truncate">
                    {short}
                  </span>
                  <span
                    style={{
                      color: ok ? "var(--accent-down)" : "var(--accent-danger)",
                    }}
                  >
                    {status}
                  </span>
                </div>
              )
            })}
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">redis</span>
              <span
                style={{
                  color: ov?.system.redis
                    ? "var(--accent-down)"
                    : "var(--accent-danger)",
                }}
              >
                {ov?.system.redis ? "ok" : "down"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-muted)]">postgres</span>
              <span
                style={{
                  color: ov?.system.postgres
                    ? "var(--accent-down)"
                    : "var(--accent-danger)",
                }}
              >
                {ov?.system.postgres ? "ok" : "down"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 快捷入口 */}
      <Card>
        <CardHeader className="space-y-0">
          <CardTitle>快捷入口</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/admin/users">
            <Button variant="outline">
              <Users className="w-4 h-4" />
              用户管理
            </Button>
          </Link>
          <Link href="/admin/users">
            <Button variant="outline">
              <UserPlus className="w-4 h-4" />
              新增用户
            </Button>
          </Link>
          <Link href="/admin/ai">
            <Button variant="outline">
              <Bot className="w-4 h-4" />
              AI 监管
            </Button>
          </Link>
          <Link href="/admin/channels">
            <Button variant="outline">
              <Activity className="w-4 h-4" />
              渠道监控
            </Button>
          </Link>
          <Link href="/admin/settings">
            <Button variant="outline">
              <Settings className="w-4 h-4" />
              系统设置
            </Button>
          </Link>
          <Link href="/admin/logs">
            <Button variant="outline">
              <Server className="w-4 h-4" />
              系统日志
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
