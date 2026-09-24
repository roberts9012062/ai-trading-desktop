"use client"

/** 用户配额覆盖卡片 —— 管理员后台单独设置某用户的任务数/因子/回测配额 */

import { useEffect, useState } from "react"
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
  const [maxTasks, setMaxTasks] = useState("")
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
        setMaxTasks(q.max_tasks_override?.toString() ?? "")
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
    setSaving(true)
    setMsg("")
    setError("")
    try {
      await updateAdminUserApi(userId, {
        max_tasks_override: maxTasks === "" ? null : Number(maxTasks),
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
        <CardTitle>用量配额覆盖</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-[var(--text-muted)]">
          空值=用全局默认；填数字=覆盖；0=不限。管理员不限。
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>最大任务数</Label>
            <Input
              type="number"
              min={0}
              value={maxTasks}
              placeholder={`全局 ${fmtLimit(eff?.max_tasks)}`}
              onChange={(e) => setMaxTasks(e.target.value)}
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
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中…" : "保存配额"}
        </Button>
      </CardContent>
    </Card>
  )
}
