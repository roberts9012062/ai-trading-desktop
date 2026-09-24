"use client"

import { useEffect } from "react"
import Link from "next/link"
import { cn, formatShanghaiTime } from "@/lib/utils"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Loader2 } from "lucide-react"
import { ExchangeCredentialsPanel } from "@/components/trading/exchange-credentials-panel"
import type { PaperLedgerItem } from "@/lib/paper-api"

function formatMoney(v: number): string {
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function flowTypeLabel(type: string): string {
  const map: Record<string, string> = {
    claim: "领取",
    freeze: "冻结",
    unfreeze: "解冻",
    fee: "手续费",
    open: "开仓",
    close: "平仓盈亏",
    settlement: "结算",
  }
  return map[type] ?? type
}

/** 实盘资产卡片 + 持仓（live 模式） */
function LiveAssetsView(): React.JSX.Element {
  const account = usePaperTradingStore((s) => s.account)
  const positions = usePaperTradingStore((s) => s.positions)
  const loading = usePaperTradingStore((s) => s.loading)
  const error = usePaperTradingStore((s) => s.error)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const mode = usePaperTradingStore((s) => s.mode)
  const venue = usePaperTradingStore((s) => s.venue)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const cards = [
    { label: `总权益（${venue.toUpperCase()}）`, value: formatMoney(account?.total_equity ?? 0) },
    { label: "可用余额", value: formatMoney(account?.available_margin ?? 0) },
    { label: "持仓占用", value: formatMoney(account?.position_margin ?? 0) },
    { label: "浮动盈亏", value: account?.unrealized_pnl ?? 0, isPnl: true },
  ]
  const upl = positions.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            实盘账户
            <Badge variant="outline" className="ml-2 text-[10px] align-middle">
              {account?.venue_name ?? venue.toUpperCase()}
            </Badge>
            {account?.demo && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-warn)]/15 text-[var(--accent-warn)] align-middle">
                模拟盘环境
              </span>
            )}
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            数据实时来自交易所 · 委托/持仓明细见「交易」「持仓」页
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1" disabled={loading} onClick={() => void refresh()}>
          {loading && <Loader2 className="w-3 h-3 animate-spin" />}
          刷新
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-danger)]/10 text-[var(--accent-danger)] text-xs">
          {error}
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3">
              <p className="text-xs text-[var(--text-muted)]">{c.label}</p>
              <p
                className={cn(
                  "text-base font-semibold font-num mt-1",
                  c.isPnl
                    ? (c.value as number) >= 0
                      ? "text-up"
                      : "text-down"
                    : "text-[var(--text-primary)]",
                )}
              >
                {c.isPnl
                  ? `${(c.value as number) >= 0 ? "+" : ""}${formatMoney(c.value as number)}`
                  : c.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
            <span className="text-xs font-medium">实盘持仓</span>
            <span className={cn("text-xs font-num", upl >= 0 ? "text-up" : "text-down")}>
              浮动合计 {upl >= 0 ? "+" : ""}
              {formatMoney(upl)} USDT
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">合约</TableHead>
                <TableHead className="text-xs">方向</TableHead>
                <TableHead className="text-xs font-num">数量</TableHead>
                <TableHead className="text-xs font-num">开仓均价</TableHead>
                <TableHead className="text-xs font-num">浮盈</TableHead>
                <TableHead className="text-xs font-num">强平价</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-xs text-[var(--text-muted)] py-6">
                    暂无持仓
                  </TableCell>
                </TableRow>
              ) : (
                positions.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs font-medium">{p.symbol}</TableCell>
                    <TableCell>
                      <Badge variant={p.direction === "long" ? "up" : "down"} className="text-[10px]">
                        {p.direction === "long" ? "多" : "空"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-num text-xs">{p.quantity}</TableCell>
                    <TableCell className="font-num text-xs">{p.avg_price}</TableCell>
                    <TableCell
                      className={cn(
                        "font-num text-xs",
                        (p.unrealized_pnl ?? 0) >= 0 ? "text-up" : "text-down",
                      )}
                    >
                      {(p.unrealized_pnl ?? 0) >= 0 ? "+" : ""}
                      {formatMoney(p.unrealized_pnl ?? 0)}
                    </TableCell>
                    <TableCell className="font-num text-xs text-[var(--text-muted)]">
                      {(p as { liquidation_price?: number }).liquidation_price || "--"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-[10px] text-[var(--text-muted)]">
        {mode === "live" ? "实盘下单直接路由到交易所；切换交易所在「交易」页顶栏。" : ""}
      </p>
    </div>
  )
}

/** 资产中心 —— 实盘（三所） / 虚拟盘双模式 */
export default function AssetsPage(): React.JSX.Element {
  const mode = usePaperTradingStore((s) => s.mode)
  const account = usePaperTradingStore((s) => s.account)
  const ledgers = usePaperTradingStore((s) => s.ledgers)
  const loading = usePaperTradingStore((s) => s.loading)
  const refresh = usePaperTradingStore((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (mode === "live") {
    return (
      <div className="flex flex-col h-full overflow-auto p-4 space-y-4">
        <ExchangeCredentialsPanel />
        <LiveAssetsView />
      </div>
    )
  }

  const cards = [
    {
      label: "总权益",
      value: formatMoney(account?.total_equity ?? 0),
    },
    {
      label: "可用保证金",
      value: formatMoney(account?.available_margin ?? 0),
    },
    {
      label: "冻结保证金",
      value: formatMoney(account?.frozen_margin ?? 0),
    },
    {
      label: "已实现盈亏",
      value: account?.realized_pnl ?? 0,
      isPnl: true,
    },
    {
      label: "浮动盈亏",
      value: account?.unrealized_pnl ?? 0,
      isPnl: true,
    },
    {
      label: "累计领取",
      value: formatMoney(account?.total_claimed ?? 0),
    },
    {
      label: "累计入金",
      value: formatMoney(account?.total_deposit ?? 0),
    },
    {
      label: "风险率",
      value: `${(account?.risk_rate ?? 0).toFixed(2)}%`,
    },
  ]

  return (
    <div className="flex flex-col h-full overflow-auto p-4 space-y-4">
      <ExchangeCredentialsPanel />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            资产中心
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            模拟账户 · 虚拟练习金
            {account?.can_claim
              ? " · 本月可领取"
              : account?.last_claim_month
                ? ` · ${account.last_claim_month} 已领取`
                : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/profile">领取练习金</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading && <Loader2 className="w-3 h-3 animate-spin" />}
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3">
              <p className="text-xs text-[var(--text-muted)]">{c.label}</p>
              <p
                className={cn(
                  "text-base font-semibold font-num mt-1",
                  c.isPnl
                    ? (c.value as number) >= 0
                      ? "text-up"
                      : "text-down"
                    : "text-[var(--text-primary)]"
                )}
              >
                {c.isPnl
                  ? `${(c.value as number) >= 0 ? "+" : ""}${formatMoney(c.value as number)}`
                  : c.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="flows">
        <TabsList>
          <TabsTrigger value="flows">资金流水</TabsTrigger>
          <TabsTrigger value="claim">领取说明</TabsTrigger>
        </TabsList>

        <TabsContent value="flows">
          <Card>
            <CardContent className="p-0">
              <FundFlowTable flows={ledgers} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="claim">
          <Card>
            <CardContent className="p-4 space-y-2 text-sm text-[var(--text-secondary)]">
              <p>
                每月可在「个人中心 → 虚拟资金」领取{" "}
                <span className="font-num text-[var(--text-primary)]">
                  {formatMoney(account?.claim_amount ?? 1_000_000)} USDT
                </span>{" "}
                虚拟练习金。
              </p>
              <p>
                当前月份：
                <span className="font-num">
                  {account?.current_claim_month ?? "--"}
                </span>
                {" · "}
                {account?.can_claim ? "可领取" : "本月已领取"}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                资金仅用于本系统模拟交易，不可提现。手续费与保证金按期货品种规则计算，可在交易设置中调整。
              </p>
              <Button asChild size="sm" className="mt-2">
                <Link href="/profile">前往领取</Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function FundFlowTable(props: { flows: PaperLedgerItem[] }): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>金额</TableHead>
          <TableHead>余额</TableHead>
          <TableHead>说明</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.flows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={5}
              className="text-center text-[var(--text-muted)] py-8"
            >
              暂无流水，领取练习金或下单后会出现记录
            </TableCell>
          </TableRow>
        ) : (
          props.flows.map((f) => (
            <TableRow key={f.id}>
              <TableCell className="font-num text-xs text-[var(--text-muted)]">
                {formatShanghaiTime(f.time)}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{flowTypeLabel(f.type)}</Badge>
              </TableCell>
              <TableCell
                className={cn(
                  "font-num text-sm",
                  f.amount >= 0 ? "text-up" : "text-down"
                )}
              >
                {f.amount >= 0 ? "+" : ""}
                {formatMoney(f.amount)}
              </TableCell>
              <TableCell className="font-num text-sm">
                {formatMoney(f.balance)}
              </TableCell>
              <TableCell className="text-xs text-[var(--text-secondary)]">
                {f.description}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
