"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RunLogPanel } from "@/components/admin/run-log-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function money(v: unknown): string {
  const n = Number(v ?? 0)
  return `¥${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function fmtTime(iso: unknown): string {
  if (!iso || typeof iso !== "string") return "-"
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false })
  } catch {
    return iso
  }
}

interface UserDetailTabsProps {
  orders: Record<string, unknown>[]
  positions: Record<string, unknown>[]
  tasks: Record<string, unknown>[]
  decisions: Record<string, unknown>[]
  pnl: Record<string, unknown> | null
  userId?: string
  tradingMode?: string
  defaultTab?: string
}

/** 用户详情页：交易 / 持仓 / AI 任务 / 决策 Tabs */
export function UserDetailTabs({
  orders,
  positions,
  tasks,
  decisions,
  pnl,
  userId,
  tradingMode,
  defaultTab,
}: UserDetailTabsProps): React.JSX.Element {
  return (
    <Tabs defaultValue={defaultTab || "orders"}>
      <TabsList>
        <TabsTrigger value="orders">交易委托</TabsTrigger>
        <TabsTrigger value="positions">持仓</TabsTrigger>
        <TabsTrigger value="ai">AI 任务</TabsTrigger>
        <TabsTrigger value="decisions">AI 决策</TabsTrigger>
        <TabsTrigger value="runlogs">运行日志</TabsTrigger>
      </TabsList>

      <TabsContent value="orders">
        <Card>
          <CardHeader>
            <CardTitle>模拟委托记录</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>合约</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead>开平</TableHead>
                  <TableHead>价格</TableHead>
                  <TableHead>手数</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>盈亏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={String(o.id)}>
                    <TableCell className="text-xs font-num">
                      {fmtTime(o.created_at)}
                    </TableCell>
                    <TableCell>
                      {String(o.symbol)}{" "}
                      <span className="text-[var(--text-muted)] text-xs">
                        {String(o.symbol_name || "")}
                      </span>
                    </TableCell>
                    <TableCell>{String(o.direction)}</TableCell>
                    <TableCell>{String(o.offset)}</TableCell>
                    <TableCell className="font-num">{String(o.price)}</TableCell>
                    <TableCell className="font-num">
                      {String(o.quantity)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{String(o.status)}</Badge>
                    </TableCell>
                    <TableCell className="font-num">
                      {money(o.realized_pnl)}
                    </TableCell>
                  </TableRow>
                ))}
                {orders.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center py-6 text-[var(--text-muted)]"
                    >
                      暂无委托
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="positions">
        <Card>
          <CardHeader>
            <CardTitle>当前持仓</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>合约</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead>手数</TableHead>
                  <TableHead>均价</TableHead>
                  <TableHead>保证金</TableHead>
                  <TableHead>已实现盈亏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={String(p.id)}>
                    <TableCell>
                      {String(p.symbol)} {String(p.symbol_name || "")}
                    </TableCell>
                    <TableCell>{String(p.direction)}</TableCell>
                    <TableCell className="font-num">
                      {String(p.quantity)}
                    </TableCell>
                    <TableCell className="font-num">
                      {String(p.avg_price)}
                    </TableCell>
                    <TableCell className="font-num">{money(p.margin)}</TableCell>
                    <TableCell className="font-num">
                      {money(p.realized_pnl)}
                    </TableCell>
                  </TableRow>
                ))}
                {positions.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-6 text-[var(--text-muted)]"
                    >
                      暂无持仓
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="ai">
        <Card>
          <CardHeader>
            <CardTitle>
              AI 交易任务
              {pnl && (
                <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
                  任务权益差合计 {money(pnl.ai_tasks_cash_delta_sum)}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>合约</TableHead>
                  <TableHead>周期</TableHead>
                  <TableHead>策略</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>权益差</TableHead>
                  <TableHead>持仓</TableHead>
                  <TableHead>最近运行</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => {
                  const poss = (t.positions as unknown[]) || []
                  return (
                    <TableRow key={String(t.id)}>
                      <TableCell>{String(t.name || "-")}</TableCell>
                      <TableCell>
                        {String(t.symbol)} {String(t.symbol_name || "")}
                      </TableCell>
                      <TableCell>{String(t.timeframe)}</TableCell>
                      <TableCell>{String(t.strategy_type || "ai")}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{String(t.status)}</Badge>
                      </TableCell>
                      <TableCell className="font-num">
                        {money(t.cash_delta)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {poss.length === 0
                          ? "-"
                          : poss
                              .map((p) => {
                                const x = p as Record<string, unknown>
                                return `${x.direction}×${x.quantity}`
                              })
                              .join(", ")}
                      </TableCell>
                      <TableCell className="text-xs font-num">
                        {fmtTime(t.last_run_at)}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {tasks.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center py-6 text-[var(--text-muted)]"
                    >
                      暂无 AI 任务
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="decisions">
        <Card>
          <CardHeader>
            <CardTitle>AI 决策日志</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>触发</TableHead>
                  <TableHead>K 线</TableHead>
                  <TableHead>原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {decisions.map((d) => (
                  <TableRow key={String(d.id)}>
                    <TableCell className="text-xs font-num">
                      {fmtTime(d.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{String(d.action)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {String(d.trigger_type || "")}
                    </TableCell>
                    <TableCell className="text-xs font-num">
                      {String(d.bar_time || "-")}
                    </TableCell>
                    <TableCell className="text-xs max-w-md truncate">
                      {String(d.reason || "")}
                    </TableCell>
                  </TableRow>
                ))}
                {decisions.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-6 text-[var(--text-muted)]"
                    >
                      暂无决策记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="runlogs">
        {userId ? (
          <RunLogPanel
            userId={userId}
            tasks={tasks}
            tradingMode={tradingMode ?? "live"}
          />
        ) : (
          <div className="text-xs text-[var(--text-muted)] p-4">
            缺少 userId 参数
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
