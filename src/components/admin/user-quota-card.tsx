"use client"

/** 用户配额覆盖卡片 —— 管理员后台单独设置某用户的任务数/因子/回测配额 */

import { useEffect, useState } from "react"
import { TaskSlotSummary } from "@/components/ai-trading/task-slot-summary"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { getUserQuotaApi, updateAdminUserApi, type UserQuota } from "@/lib/admin-api"

interface UserQuotaCardProps {
  userId: string
}

function fmtLimit(v: number | null | undefined): string {
  return v == null ? "不限" : String(v)
}

export function UserQuotaCard({ userId }: UserQuotaCardProps): React.JSX.Element {
  const [quota, setQuota] = useState<UserQuota | null>(null)
  const [giftSlots, setGiftSlots] = useState("")
  const [factor, setFactor] = useState("")
  const [backtest, setBacktest] = useState("")
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const q = await getUserQuotaApi(userId)
        if (cancelled) return
        setQuota(q)
        setGiftSlots(String(q.gift_task_slots ?? 0))
        setFactor(q.factor_lab_daily_override?.toString() ?? "")
        setBacktest(q.backtest_daily_override?.toString() ?? "")
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载配额失败")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  async function handleSave(): Promise<void> {
    if (!Number.isInteger(Number(giftSlots)) || Number(giftSlots) < 0 || Number(giftSlots) > 10000 || giftSlots === "") {
      setError("赠送任务槽须为 0~10000 的整数")
      return
    }
    setSaving(true)
    setMsg("")
    setError("")
    try {
      await updateAdminUserApi(userId, {
        gift_task_slots: Number(giftSlots),
        factor_lab_daily_override: factor === "" ? null : Number(factor),
        backtest_daily_override: backtest === "" ? null : Number(backtest),
      })
      const q = await getUserQuotaApi(userId)
      setQuota(q)
      setMsg("配额已保存")
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const eff = quota?.effective
  const used = quota?.used

  return (
    <Card>
      <CardHeader>
        <CardTitle>永久免费任务槽与用量配额</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-[var(--text-muted)]">
          赠送槽在基础免费 1 个之外永久叠加，填 0 收回全部赠送槽。有持仓的任务仅允许减仓和平仓，空仓后回收。每日次数空值=全局默认，0=不限。
        </p>
        <TaskSlotSummary slots={quota?.task_slots} />
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>永久赠送任务槽</Label>
            <Input
              type="number"
              min={0}
              value={giftSlots}
              aria-label="永久赠送任务槽"
              max={10000}
              step={1}
              onChange={(e) => setGiftSlots(e.target.value)}
            />
            {used && (
              <p className="text-[10px] text-[var(--text-muted)]">
                当前 {used.tasks} 个
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>因子/天</Label>
            <Input
              type="number"
              min={0}
              value={factor}
              placeholder={`全局 ${fmtLimit(eff?.factor_daily)}`}
              onChange={(e) => setFactor(e.target.value)}
            />
            {used && (
              <p className="text-[10px] text-[var(--text-muted)]">
                今日 {used.factor_today} 次
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label>回测/天</Label>
            <Input
              type="number"
              min={0}
              value={backtest}
              placeholder={`全局 ${fmtLimit(eff?.backtest_daily)}`}
              onChange={(e) => setBacktest(e.target.value)}
            />
            {used && (
              <p className="text-[10px] text-[var(--text-muted)]">
                今日 {used.backtest_today} 次
              </p>
            )}
          </div>
        </div>
        {msg && <p className="text-xs text-[var(--primary)]">{msg}</p>}
        {error && (
          <p className="text-xs text-[var(--accent-danger)]">{error}</p>
        )}
        <Button validateNumbers onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中…" : "保存配额"}
        </Button>
      </CardContent>
    </Card>
  )
}
