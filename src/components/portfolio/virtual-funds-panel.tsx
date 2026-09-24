"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Wallet, Gift, RefreshCw, Loader2 } from "lucide-react"
import {
  claimPaperFunds,
  getPaperAccount,
  getPaperLedgers,
  type PaperAccountSummary,
  type PaperLedgerItem,
} from "@/lib/paper-api"
import { formatShanghaiTime } from "@/lib/utils"

/** 金额格式化 */
function formatMoney(value: number): string {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 流水类型中文 */
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

/** 虚拟资金面板 —— 余额、月度领取、近期流水 */
export function VirtualFundsPanel(): React.JSX.Element {
  const [account, setAccount] = useState<PaperAccountSummary | null>(null)
  const [ledgers, setLedgers] = useState<PaperLedgerItem[]>([])
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [acc, flow] = await Promise.all([
        getPaperAccount(),
        getPaperLedgers(10, 0),
      ])
      setAccount(acc)
      setLedgers(flow.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleClaim = async () => {
    setClaiming(true)
    setError(null)
    setMessage(null)
    try {
      const acc = await claimPaperFunds()
      setAccount(acc)
      setMessage(`已领取 ${formatMoney(acc.claim_amount)} USDT 虚拟练习金`)
      const flow = await getPaperLedgers(10, 0)
      setLedgers(flow.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : "领取失败")
    } finally {
      setClaiming(false)
    }
  }

  if (loading && !account) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] py-12">
        <Loader2 className="w-4 h-4 animate-spin" />
        加载虚拟账户…
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Wallet className="w-5 h-5 text-[var(--primary)]" />
          虚拟练习资金
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="gap-1"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        每月可领取 100 万人民币虚拟练习金，用于后续模拟交易（开平仓、保证金占用）。
        资金仅在本系统内有效，不可提现。
      </p>

      {error && (
        <div className="text-sm text-[var(--accent-danger)] bg-[var(--accent-danger)]/10 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      {message && (
        <div className="text-sm text-[var(--accent-up)] bg-[var(--accent-up)]/10 rounded-md px-3 py-2">
          {message}
        </div>
      )}

      {/* 余额卡片 */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-[var(--text-muted)]">总权益</p>
              <p className="text-2xl font-num font-semibold text-[var(--text-primary)] mt-1">
                {formatMoney(account?.total_equity ?? 0)} USDT
              </p>
            </div>
            <Badge variant={account?.can_claim ? "up" : "outline"}>
              {account?.can_claim
                ? `${account.current_claim_month} 可领取`
                : `${account?.last_claim_month ?? ""} 已领取`}
            </Badge>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="可用保证金" value={account?.available_margin ?? 0} />
            <Metric label="冻结保证金" value={account?.frozen_margin ?? 0} />
            <Metric label="累计领取" value={account?.total_claimed ?? 0} />
            <Metric label="已实现盈亏" value={account?.realized_pnl ?? 0} signed />
          </div>
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-[var(--text-muted)]">
              本月额度 {formatMoney(account?.claim_amount ?? 1_000_000)} USDT · 风险率{" "}
              {(account?.risk_rate ?? 0).toFixed(2)}%
            </p>
            <Button
              size="sm"
              className="gap-1"
              disabled={!account?.can_claim || claiming}
              onClick={() => void handleClaim()}
            >
              {claiming ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Gift className="w-3.5 h-3.5" />
              )}
              {account?.can_claim ? "领取本月 100 万" : "本月已领取"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 近期流水 */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">近期资金流水</p>
          <Separator />
          {ledgers.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-4 text-center">
              暂无流水，领取练习金后会出现记录
            </p>
          ) : (
            <div className="space-y-2">
              {ledgers.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-3 text-xs py-1.5 border-b border-[var(--border)]/40 last:border-0"
                >
                  <span className="font-num text-[var(--text-muted)] w-[140px] shrink-0">
                    {formatShanghaiTime(row.time)}
                  </span>
                  <span className="text-[var(--text-secondary)] w-[64px] shrink-0">
                    {flowTypeLabel(row.type)}
                  </span>
                  <span
                    className={`font-num w-[100px] shrink-0 ${
                      row.amount >= 0
                        ? "text-[var(--accent-up)]"
                        : "text-[var(--accent-danger)]"
                    }`}
                  >
                    {row.amount >= 0 ? "+" : ""}
                    {formatMoney(row.amount)}
                  </span>
                  <span className="text-[var(--text-muted)] truncate flex-1">
                    {row.description}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Metric(props: {
  label: string
  value: number
  signed?: boolean
}): React.JSX.Element {
  const color =
    props.signed && props.value !== 0
      ? props.value > 0
        ? "text-[var(--accent-up)]"
        : "text-[var(--accent-danger)]"
      : "text-[var(--text-primary)]"
  return (
    <div className="rounded-md bg-[var(--bg-tertiary)]/50 px-3 py-2">
      <p className="text-[10px] text-[var(--text-muted)]">{props.label}</p>
      <p className={`text-sm font-num mt-0.5 ${color}`}>
        {props.signed && props.value > 0 ? "+" : ""}{formatMoney(props.value)} USDT
      </p>
    </div>
  )
}
