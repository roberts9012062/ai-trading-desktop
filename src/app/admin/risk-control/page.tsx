"use client"

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table"
import { getMockAdminUsers, getMockSystemLogs } from "@/lib/mock"

/** 风控监控页面 */
export default function AdminRiskControlPage(): React.JSX.Element {
  const users = getMockAdminUsers()
  const logs = getMockSystemLogs()

  /** 风险用户：风险率 > 50% */
  const riskUsers = users.filter((u) => u.riskRate > 50)

  /** 风控相关日志 */
  const riskLogs = logs.filter(
    (l) => l.module === "风控系统" || l.level === "WARN" || l.level === "ERROR"
  )

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">风控监控</h1>

      {/* 风险统计摘要 */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">高风险用户数</p>
            <p className="text-xl font-semibold font-num mt-1 text-[var(--accent-up)]">
              {riskUsers.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">预警用户数（风险率 &gt; 80%）</p>
            <p className="text-xl font-semibold font-num mt-1 text-[var(--accent-warn)]">
              {users.filter((u) => u.riskRate > 80).length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[var(--text-muted)]">今日风控事件</p>
            <p className="text-xl font-semibold font-num mt-1 text-[var(--primary)]">
              {riskLogs.length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 风险用户列表 */}
      <Card>
        <CardHeader>
          <CardTitle>风险用户列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户 ID</TableHead>
                <TableHead>昵称</TableHead>
                <TableHead>手机号</TableHead>
                <TableHead>账户状态</TableHead>
                <TableHead>风险率</TableHead>
                <TableHead>风险等级</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {riskUsers.map((user) => {
                const isHigh = user.riskRate > 80
                return (
                  <TableRow
                    key={user.id}
                    className={isHigh ? "bg-[var(--accent-up)]/5" : ""}
                  >
                    <TableCell className="font-num text-[var(--text-secondary)]">
                      {user.id}
                    </TableCell>
                    <TableCell className="text-[var(--text-primary)]">
                      {user.username}
                    </TableCell>
                    <TableCell className="font-num">{user.phone}</TableCell>
                    <TableCell>
                      <Badge variant={user.status === "active" ? "up" : "destructive"}>
                        {user.status === "active" ? "正常" : "冻结"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`font-num text-sm font-semibold ${
                          isHigh ? "text-[var(--accent-up)]" : "text-[var(--accent-warn)]"
                        }`}
                      >
                        {user.riskRate.toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={isHigh ? "destructive" : "outline"}>
                        {isHigh ? "高风险" : "预警"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
              {riskUsers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-[var(--text-muted)] py-8">
                    当前无风险用户
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 风控日志 */}
      <Card>
        <CardHeader>
          <CardTitle>风控日志</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>级别</TableHead>
                <TableHead>模块</TableHead>
                <TableHead>内容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {riskLogs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-num text-[var(--text-muted)] whitespace-nowrap">
                    {log.time}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        log.level === "ERROR"
                          ? "destructive"
                          : log.level === "WARN"
                            ? "outline"
                            : "up"
                      }
                    >
                      {log.level}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{log.module}</TableCell>
                  <TableCell className="text-[var(--text-primary)]">{log.message}</TableCell>
                </TableRow>
              ))}
              {riskLogs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-[var(--text-muted)] py-8">
                    暂无风控日志
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
