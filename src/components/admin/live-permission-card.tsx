"use client"
import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { setAdminLivePermissionApi } from "@/lib/admin-api"

export function LivePermissionCard({ userId, username, enabled, onChanged }: {
  userId: string; username: string; enabled: boolean; onChanged: () => void
}): React.JSX.Element {
  const [approved, setApproved] = useState(enabled)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  useEffect(() => { setApproved(enabled) }, [enabled, userId])
  async function change(): Promise<void> {
    setBusy(true); setError(""); setMessage("")
    try {
      const result = await setAdminLivePermissionApi(userId, !approved)
      setApproved(result.enabled); setMessage([result.message, ...result.warnings].join("；")); onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : "授权更新失败") }
    finally { setBusy(false) }
  }
  return <Card><CardContent className="p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">真实资金交易权限 · {username}</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{approved ? "已获管理员授权" : "未授权（默认关闭）"}</p></div>
      <Button disabled={busy} variant={approved ? "outline" : "default"} onClick={() => void change()}>
        {busy ? "处理中…" : approved ? "关闭实盘授权" : "开启实盘授权"}
      </Button>
    </div>
    <p className="text-xs leading-6 text-[var(--text-muted)]">仅控制交易所真实资金接入和新增仓位，OKX 模拟盘与虚拟盘不受影响。关闭授权会撤销待成交开仓委托，已有仓位仍可查询、撤单和平仓；开启授权不会自动启动任务。</p>
    {message && <p role="status" className="text-xs text-[var(--text-secondary)]">{message}</p>}
    {error && <p role="alert" className="text-xs text-[var(--accent-danger)]">{error}</p>}
  </CardContent></Card>
}
