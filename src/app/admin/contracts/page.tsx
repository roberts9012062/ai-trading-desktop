"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getMockAdminContracts } from "@/lib/mock"
import type { AdminContract } from "@/types"

/** 合约状态 Badge */
function ContractStatusBadge({ status }: { status: AdminContract["status"] }): React.JSX.Element {
  const map: Record<AdminContract["status"], { label: string; variant: "up" | "outline" | "destructive" }> = {
    trading: { label: "交易中", variant: "up" },
    suspended: { label: "暂停", variant: "outline" },
    delisted: { label: "已退市", variant: "destructive" },
  }
  const cfg = map[status]
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

/** 合约管理页面 */
export default function AdminContractsPage(): React.JSX.Element {
  const contracts = getMockAdminContracts()
  const [dialogOpen, setDialogOpen] = useState<boolean>(false)

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">合约管理</h1>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="w-4 h-4" />
          新增合约
        </Button>
      </div>

      {/* 合约表格 */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>合约代码</TableHead>
                <TableHead>合约名称</TableHead>
                <TableHead>交易所</TableHead>
                <TableHead>品种</TableHead>
                <TableHead>合约乘数</TableHead>
                <TableHead>最小变动价位</TableHead>
                <TableHead>手续费率</TableHead>
                <TableHead>保证金率</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contracts.map((c) => (
                <TableRow key={c.code}>
                  <TableCell className="font-num font-semibold text-[var(--text-primary)]">
                    {c.code}
                  </TableCell>
                  <TableCell className="text-[var(--text-primary)]">{c.name}</TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{c.exchange}</TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{c.category}</TableCell>
                  <TableCell className="font-num text-[var(--text-secondary)]">
                    {c.multiplier}
                  </TableCell>
                  <TableCell className="font-num text-[var(--text-secondary)]">
                    {c.minTick}
                  </TableCell>
                  <TableCell className="font-num text-[var(--text-secondary)]">
                    {(c.feeRate * 100).toFixed(2)}%
                  </TableCell>
                  <TableCell className="font-num text-[var(--text-secondary)]">
                    {(c.marginRate * 100).toFixed(0)}%
                  </TableCell>
                  <TableCell>
                    <ContractStatusBadge status={c.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 新增/编辑合约弹窗（占位） */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增合约</DialogTitle>
            <DialogDescription>填写合约基本信息</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>合约代码</Label>
                <Input placeholder="如 rb2510" />
              </div>
              <div className="space-y-2">
                <Label>合约名称</Label>
                <Input placeholder="如 螺纹钢2510" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>交易所</Label>
                <Input placeholder="如 上期所" />
              </div>
              <div className="space-y-2">
                <Label>品种</Label>
                <Input placeholder="如 黑色" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>合约乘数</Label>
                <Input type="number" placeholder="10" />
              </div>
              <div className="space-y-2">
                <Label>最小变动价位</Label>
                <Input type="number" placeholder="1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>手续费率 (%)</Label>
                <Input type="number" placeholder="0.01" />
              </div>
              <div className="space-y-2">
                <Label>保证金率 (%)</Label>
                <Input type="number" placeholder="10" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                取消
              </Button>
              <Button onClick={() => setDialogOpen(false)}>确认新增</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
