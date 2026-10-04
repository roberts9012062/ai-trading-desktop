"use client"

import { NumericInput } from "@/components/ui/numeric-input"
import React, { useEffect, useState } from "react"
import Link from "next/link"
import { cn, formatShanghaiTime } from "@/lib/utils"
import { usePaperTradingStore } from "@/stores/paper-trading"
import {
  adjustDemoBalanceApi,
  getAccountModeApi,
  placePositionTpslApi,
  setAccountModeApi,
  transferFundsApi,
  type AccountMode,
} from "@/lib/live-api"
import type { PaperPositionItem } from "@/lib/paper-api"
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
import { Loader2, AlertTriangle } from "lucide-react"
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

  // 划转 / 模拟注资 / 持仓补挂止盈止损
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferDir, setTransferDir] = useState<"in" | "out">("in")
  const [transferAmt, setTransferAmt] = useState("")
  const [fundMsg, setFundMsg] = useState<string | null>(null)
  const [fundBusy, setFundBusy] = useState(false)
  const [tpslFor, setTpslFor] = useState<PaperPositionItem | null>(null)
  const [tpPrice, setTpPrice] = useState("")
  const [slPrice, setSlPrice] = useState("")

  // 账户模式（OKX 纯现货模式无法合约交易，本系统仅支持合约）
  const [acctMode, setAcctMode] = useState<AccountMode | null>(null)
  const [modeBusy, setModeBusy] = useState(false)
  const [modeMsg, setModeMsg] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getAccountModeApi(venue)
      .then((m) => {
        if (alive) setAcctMode(m)
      })
      .catch(() => {
        // 未配置凭证/查询失败：不显示模式提示（凭证区另有引导）
        if (alive) setAcctMode(null)
      })
    return () => {
      alive = false
    }
  }, [venue])

  async function switchToContractMode(): Promise<void> {
    setModeBusy(true)
    setModeMsg(null)
    try {
      const res = await setAccountModeApi(venue, "2")
      setModeMsg(
        res.changed
          ? `已切换为合约模式（${res.label ?? "现货+合约"}），现在可以正常开仓了`
          : `账户已是合约模式（${res.label ?? ""}）`,
      )
      const m = await getAccountModeApi(venue)
      setAcctMode(m)
    } catch (e) {
      setModeMsg(e instanceof Error ? e.message : "切换失败，请到 OKX 官方「交易设置」手动切换")
    } finally {
      setModeBusy(false)
    }
  }

  async function doTransfer(): Promise<void> {
    const amt = Number(transferAmt)
    if (!Number.isFinite(amt) || amt <= 0) {
      setFundMsg("请输入有效金额")
      return
    }
    setFundBusy(true)
    setFundMsg(null)
    try {
      await transferFundsApi({
        venue,
        ccy: "USDT",
        amt,
        from_account: transferDir === "in" ? "funding" : "trading",
        to_account: transferDir === "in" ? "trading" : "funding",
      })
      setFundMsg(
        transferDir === "in"
          ? "划转成功：资金账户 → 交易账户"
          : "划转成功：交易账户 → 资金账户"
      )
      setTransferAmt("")
      await refresh()
    } catch (e) {
      setFundMsg(e instanceof Error ? e.message : "划转失败")
    } finally {
      setFundBusy(false)
    }
  }

  async function doDemoTopUp(): Promise<void> {
    setFundBusy(true)
    setFundMsg(null)
    try {
      await adjustDemoBalanceApi({
        venue,
        direction: "increase",
        adjustments: [{ ccy: "USDT", amt: 3000 }],
      })
      setFundMsg("已注入 3000 USDT 模拟资金（每日最多 3 次）")
      await refresh()
    } catch (e) {
      setFundMsg(e instanceof Error ? e.message : "注入失败")
    } finally {
      setFundBusy(false)
    }
  }

  async function doTpsl(): Promise<void> {
    if (!tpslFor) return
    const tp = Number(tpPrice) || null
    const sl = Number(slPrice) || null
    if (!tp && !sl) {
      setFundMsg("止盈价与止损价至少填一个")
      return
    }
    setFundBusy(true)
    setFundMsg(null)
    try {
      await placePositionTpslApi({
        venue,
        symbol: tpslFor.symbol,
        pos_side: tpslFor.direction === "long" ? "long" : "short",
        tp_price: tp && tp > 0 ? tp : null,
        sl_price: sl && sl > 0 ? sl : null,
      })
      setFundMsg(`已为 ${tpslFor.symbol} 挂出止盈/止损条件单（触发后市价平仓）`)
      setTpslFor(null)
    } catch (e) {
      setFundMsg(e instanceof Error ? e.message : "条件单失败")
    } finally {
      setFundBusy(false)
    }
  }

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
      {acctMode?.supported && !acctMode.can_trade_contract && (
        <div className="flex items-start gap-3 rounded-lg border border-[var(--accent-danger)]/40 bg-[var(--accent-danger)]/10 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-[var(--accent-danger)] shrink-0 mt-0.5" />
          <div className="flex-1 space-y-2">
            <p className="text-sm text-[var(--text-primary)] font-medium">
              当前 OKX 账户为「{acctMode.label ?? "现货模式"}」——本系统仅支持合约交易
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              现货模式的账户无法下单永续合约，任务开仓会被交易所全部拒绝。
              请切换为合约模式（现货+合约，单币种保证金）后再使用；资金与持仓不受影响。
            </p>
            {modeMsg && (
              <p className="text-xs text-[var(--accent-up)]">{modeMsg}</p>
            )}
            <Button size="sm" disabled={modeBusy} onClick={() => void switchToContractMode()}>
              {modeBusy ? "切换中…" : "一键切换为合约模式"}
            </Button>
          </div>
        </div>
      )}
      {acctMode?.supported && acctMode.can_trade_contract && modeMsg && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-up)]/10 text-[var(--accent-up)] text-xs">
          {modeMsg}
        </div>
      )}
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
        <div className="flex items-center gap-2">
          {account?.demo && (
            <Button
              variant="outline"
              size="sm"
              disabled={fundBusy}
              onClick={() => void doDemoTopUp()}
              title="OKX 模拟盘专用：注入模拟 USDT（单次上限 5000，每日 3 次）"
            >
              注入模拟资金
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={fundBusy}
            onClick={() => {
              setTransferOpen((v) => !v)
              setFundMsg(null)
            }}
          >
            资金划转
          </Button>
          <Button variant="outline" size="sm" className="gap-1" disabled={loading} onClick={() => void refresh()}>
            {loading && <Loader2 className="w-3 h-3 animate-spin" />}
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-danger)]/10 text-[var(--accent-danger)] text-xs">
          {error}
        </div>
      )}

      {transferOpen && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
          <p className="text-[11px] text-[var(--text-muted)]">
            合约交易（任务/手动开仓）使用「合约账户」余额；资金账户的钱不会自动用于合约下单，
            请先划入。合约账户即 OKX 的交易账户。
          </p>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-[var(--text-secondary)] font-medium">资金划转（USDT）</span>
            <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
              <button
                type="button"
                className={`px-2.5 py-1 text-[11px] ${transferDir === "in" ? "bg-[var(--primary)]/15 text-[var(--primary)]" : "text-[var(--text-muted)]"}`}
                onClick={() => setTransferDir("in")}
              >
                资金账户 → 合约账户
              </button>
              <button
                type="button"
                className={`px-2.5 py-1 text-[11px] ${transferDir === "out" ? "bg-[var(--primary)]/15 text-[var(--primary)]" : "text-[var(--text-muted)]"}`}
                onClick={() => setTransferDir("out")}
              >
                合约账户 → 资金账户
              </button>
            </div>
            <NumericInput
              type="number"
              min="0"
              step="any"
              placeholder="金额"
              value={transferAmt}
              onChange={(e) => setTransferAmt(e.target.value)}
              className="w-28 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs font-num"
            />
            <Button validateNumbers size="sm" disabled={fundBusy} onClick={() => void doTransfer()}>
              {fundBusy ? "划转中…" : "确认划转"}
            </Button>
          </div>
        </div>
      )}
      {fundMsg && (
        <div className="px-3 py-2 rounded-md bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)]">
          {fundMsg}
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
                <TableHead className="text-xs">保护单</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-xs text-[var(--text-muted)] py-6">
                    暂无持仓
                  </TableCell>
                </TableRow>
              ) : (
                positions.map((p) => (
                  <React.Fragment key={p.id}>
                  <TableRow>
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
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[11px]"
                        onClick={() => {
                          setTpslFor(tpslFor?.id === p.id ? null : p)
                          setTpPrice("")
                          setSlPrice("")
                        }}
                      >
                        {tpslFor?.id === p.id ? "收起" : "补挂"}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {tpslFor?.id === p.id && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-[var(--bg-tertiary)]/40">
                        <div className="flex items-center gap-2 py-1 flex-wrap">
                          <span className="text-xs text-[var(--text-secondary)]">
                            {p.symbol} {p.direction === "long" ? "多" : "空"} 补挂条件单（触发后市价平仓）
                          </span>
                          <NumericInput
                            type="number"
                            step="any"
                            min="0"
                            placeholder="止盈价"
                            value={tpPrice}
                            onChange={(e) => setTpPrice(e.target.value)}
                            className="w-28 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs font-num"
                          />
                          <NumericInput
                            type="number"
                            step="any"
                            min="0"
                            placeholder="止损价"
                            value={slPrice}
                            onChange={(e) => setSlPrice(e.target.value)}
                            className="w-28 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs font-num"
                          />
                          <Button validateNumbers size="sm" disabled={fundBusy} onClick={() => void doTpsl()}>
                            {fundBusy ? "提交中…" : "挂出"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setTpslFor(null)}>
                            取消
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  </React.Fragment>
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
