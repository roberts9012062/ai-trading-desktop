"use client"

import { useState } from "react"
import { CheckCircle, XCircle, DollarSign, TrendingUp, ArrowDownUp } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table"
import { getMockDeposits } from "@/lib/mock"
import type { DepositRecord } from "@/types"

/** 出金/入金状态 Badge */
function FinanceStatusBadge({ status }: { status: DepositRecord["status"] }): React.JSX.Element {
  const map: Record<
    DepositRecord["status"],
    { label: string; variant: "outline" | "up" | "destructive" | "default" }
  > = {
    pending: { label: "待审核", variant: "outline" },
    approved: { label: "已通过", variant: "up" },
    rejected: { label: "已驳回", variant: "destructive" },
    completed: { label: "已完成", variant: "default" },
  }
  const cfg = map[status]
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

/** 财务管理页面 */
export default function AdminFinancePage(): React.JSX.Element {
  const deposits = getMockDeposits()
  const [activeTab, setActiveTab] = useState<string>("review")

  /** 待审核记录 */
  const pendingDeposits = deposits.filter((d) => d.status === "pending")
  /** 已完成记录 */
  const allDeposits = deposits

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">财务管理</h1>

      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-muted)]">今日入金总额</p>
                <p className="text-xl font-semibold font-num mt-1 text-[var(--accent-up)]">
                  1,250,000.00
                </p>
              </div>
              <TrendingUp className="w-4 h-4 text-[var(--accent-up)] opacity-60" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-muted)]">今日出金总额</p>
                <p className="text-xl font-semibold font-num mt-1 text-[var(--accent-down)]">
                  380,000.00
                </p>
              </div>
              <DollarSign className="w-4 h-4 text-[var(--accent-down)] opacity-60" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-muted)]">待审核笔数</p>
                <p className="text-xl font-semibold font-num mt-1 text-[var(--accent-warn)]">
                  {pendingDeposits.length}
                </p>
              </div>
              <ArrowDownUp className="w-4 h-4 text-[var(--accent-warn)] opacity-60" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-muted)]">累计手续费收入</p>
                <p className="text-xl font-semibold font-num mt-1 text-[var(--primary)]">
                  86,520.00
                </p>
              </div>
              <DollarSign className="w-4 h-4 text-[var(--primary)] opacity-60" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tab 区域：出入金审核 / 全部记录 */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="review">出入金审核</TabsTrigger>
          <TabsTrigger value="all">全部记录</TabsTrigger>
          <TabsTrigger value="stats">统计报表</TabsTrigger>
        </TabsList>

        {/* 出入金审核列表 */}
        <TabsContent value="review">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>申请时间</TableHead>
                    <TableHead>银行账户</TableHead>
                    <TableHead>金额（元）</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingDeposits.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-[var(--text-muted)] py-8">
                        暂无待审核记录
                      </TableCell>
                    </TableRow>
                  ) : (
                    pendingDeposits.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-num text-[var(--text-secondary)] whitespace-nowrap">
                          {d.applyTime}
                        </TableCell>
                        <TableCell className="text-[var(--text-secondary)]">{d.bank}</TableCell>
                        <TableCell>
                          <span
                            className={`font-num font-semibold ${
                              d.amount > 0 ? "text-[var(--accent-up)]" : "text-[var(--accent-down)]"
                            }`}
                          >
                            {d.amount > 0 ? "+" : ""}
                            {d.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={d.amount > 0 ? "up" : "down"}>
                            {d.amount > 0 ? "入金" : "出金"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <FinanceStatusBadge status={d.status} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button variant="default" size="sm">
                              <CheckCircle className="w-3.5 h-3.5" />
                              通过
                            </Button>
                            <Button variant="destructive" size="sm">
                              <XCircle className="w-3.5 h-3.5" />
                              驳回
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 全部记录 */}
        <TabsContent value="all">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>申请时间</TableHead>
                    <TableHead>银行账户</TableHead>
                    <TableHead>金额（元）</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allDeposits.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-num text-[var(--text-secondary)] whitespace-nowrap">
                        {d.applyTime}
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)]">{d.bank}</TableCell>
                      <TableCell>
                        <span
                          className={`font-num ${
                            d.amount > 0 ? "text-[var(--accent-up)]" : "text-[var(--accent-down)]"
                          }`}
                        >
                          {d.amount > 0 ? "+" : ""}
                          {d.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}
                        </span>
                      </TableCell>
                      <TableCell>
                        <FinanceStatusBadge status={d.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 统计报表占位 */}
        <TabsContent value="stats">
          <Card>
            <CardHeader>
              <CardTitle>资金趋势</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-48 flex items-center justify-center text-[var(--text-muted)] text-sm">
                资金趋势图表（待接入图表库）
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
