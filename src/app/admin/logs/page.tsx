"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { Search } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table"
import { getOpsAlertsApi, type OpsAlert } from "@/lib/admin-api"
import { getMarketWebSocket } from "@/lib/websocket"

/** 时间戳（秒）→ 本地可读时间 */
function formatTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false })
  } catch {
    return String(ts)
  }
}

/** 日志级别 Badge */
function LevelBadge({ level }: { level: OpsAlert["level"] }): React.JSX.Element {
  const variantMap: Record<
    OpsAlert["level"],
    "up" | "outline" | "destructive"
  > = {
    info: "up",
    warning: "outline",
    error: "destructive",
    critical: "destructive",
  }
  const labelMap: Record<OpsAlert["level"], string> = {
    info: "INFO",
    warning: "WARN",
    error: "ERROR",
    critical: "CRIT",
  }
  return (
    <Badge variant={variantMap[level] ?? "outline"}>
      {labelMap[level] ?? level.toUpperCase()}
    </Badge>
  )
}

/** 事件源 → 中文标签 */
const SOURCE_LABEL: Record<string, string> = {
  simnow_fallback: "主源失效",
  bridge_self_heal: "Bridge自愈",
  channel_switch: "渠道切换",
  bridge_down: "Bridge异常",
}

const LEVELS = ["all", "info", "warning", "error", "critical"] as const
const LEVEL_LABEL: Record<string, string> = {
  all: "全部",
  info: "INFO",
  warning: "WARN",
  error: "ERROR",
  critical: "CRIT",
}

/** 运维告警页面：行情链路事件流（实时推送 + 历史可查） */
export default function AdminLogsPage(): React.JSX.Element {
  const [alerts, setAlerts] = useState<OpsAlert[]>([])
  const [keyword, setKeyword] = useState<string>("")
  const [levelFilter, setLevelFilter] = useState<string>("all")
  const seenIds = useRef<Set<string>>(new Set())

  // 拉历史 + 每 10s 轮询（权威数据源，Redis List 留 7 天）
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await getOpsAlertsApi()
        if (!cancelled) {
          setAlerts(data)
          data.forEach((a) => seenIds.current.add(a.id))
        }
      } catch {
        // 静默（网络/鉴权异常不打扰页面）
      }
    }
    void load()
    const id = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // WS 实时：收到 ops_alert 立即 prepend（onMessage 支持多回调，不覆盖其他页面）
  useEffect(() => {
    const ws = getMarketWebSocket()
    ws.connect()
    const off = ws.onMessage((message) => {
      if (
        message.type !== "ops_alert" ||
        !message.data ||
        typeof message.data !== "object"
      )
        return
      const alert = message.data as OpsAlert
      if (!alert.id || seenIds.current.has(alert.id)) return
      seenIds.current.add(alert.id)
      setAlerts((prev) => [alert, ...prev].slice(0, 200))
    })
    return () => off()
  }, [])

  /** 按级别 + 关键词过滤 */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return alerts.filter((a) => {
      const matchLevel = levelFilter === "all" || a.level === levelFilter
      const matchKeyword =
        kw === "" ||
        a.title.toLowerCase().includes(kw) ||
        a.source.toLowerCase().includes(kw) ||
        (SOURCE_LABEL[a.source] ?? "").includes(kw)
      return matchLevel && matchKeyword
    })
  }, [alerts, keyword, levelFilter])

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          运维告警
        </h1>
        <span className="text-xs text-[var(--text-muted)]">
          行情链路事件（主源失效 / bridge 自愈 / 渠道切换 / 容器异常）·实时推送·保留 7 天
        </span>
      </div>

      {/* 搜索筛选栏 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <Input
                placeholder="搜索来源或内容"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-muted)]">级别：</span>
              {LEVELS.map((lv) => (
                <Button
                  key={lv}
                  variant={levelFilter === lv ? "default" : "outline"}
                  size="sm"
                  onClick={() => setLevelFilter(lv)}
                >
                  {LEVEL_LABEL[lv]}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 告警表格 */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">时间</TableHead>
                <TableHead className="w-[80px]">级别</TableHead>
                <TableHead className="w-[120px]">来源</TableHead>
                <TableHead>事件</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((alert) => (
                <TableRow key={alert.id}>
                  <TableCell className="font-num text-[var(--text-secondary)] whitespace-nowrap">
                    {formatTime(alert.ts)}
                  </TableCell>
                  <TableCell>
                    <LevelBadge level={alert.level} />
                  </TableCell>
                  <TableCell className="text-[var(--text-secondary)]">
                    {SOURCE_LABEL[alert.source] ?? alert.source}
                  </TableCell>
                  <TableCell className="text-[var(--text-primary)]">
                    {alert.title}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-[var(--text-muted)] py-8"
                  >
                    暂无告警事件
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
