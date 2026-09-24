"use client"

import { useEffect, useState } from "react"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

interface HealthMarket {
  active_channel?: string
  live?: { channel?: string }
  ok?: boolean
}
interface HealthResp {
  status?: string
  market?: HealthMarket
}

/** 工作台顶部 —— 显示当前生效行情渠道（主 / 备） */
export function ActiveChannelBadge(): React.JSX.Element {
  const [active, setActive] = useState<string>("")

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const r = await fetch(`${API_BASE}/api/market/channel-status`)
        if (!r.ok) return
        const d: { active_channel?: string } = await r.json()
        setActive(d.active_channel ?? "")
      } catch {
        // 静默：健康检查失败不打扰用户
      }
    }
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [])

  if (!active) return <></>
  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-[var(--bg-secondary)] border border-[var(--border)] text-xs">
      <span className="w-2 h-2 rounded-full bg-[var(--accent-down)] animate-pulse" />
      <span className="text-[var(--text-muted)]">行情渠道</span>
      <span className="font-medium text-[var(--text-primary)]">{active}</span>
    </div>
  )
}
