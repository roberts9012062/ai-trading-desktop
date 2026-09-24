"use client"

import { useEffect, useState } from "react"
import { Megaphone } from "lucide-react"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** 公告条：优先日线信号摘要，无信号时显示系统提示 */
export function AnnouncementBar(): React.JSX.Element {
  const [messages, setMessages] = useState<string[]>([
    "工作台已接入模拟账户、持仓、成交与 AI 交易实时数据",
  ])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token =
          typeof window !== "undefined"
            ? localStorage.getItem("access_token")
            : null
        const res = await fetch(
          `${API_BASE}/api/market/signals?period=1d`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        )
        if (!res.ok) return
        const data = (await res.json()) as {
          market_open?: boolean
          message?: string
          items?: Array<{ label: string; name: string; symbol: string }>
        }
        if (cancelled) return
        if (data.market_open === false) {
          setMessages([
            data.message ||
              "休市中，信号筛查已暂停；开盘后自动恢复（夜盘约21:00）",
          ])
          return
        }
        const items = (data.items ?? []).slice(0, 12)
        if (items.length === 0) {
          setMessages([
            data.message || "全市场主力信号扫描中 / 暂无交叉与多空排列",
          ])
          return
        }
        setMessages(
          items.map((i) => {
            const name =
              (i as { product_name?: string }).product_name ||
              i.name ||
              i.symbol
            return `【${i.label}】${name}（${i.symbol}）`
          }),
        )
      } catch {
        /* 保持默认文案 */
      }
    }
    load()
    const timer = setInterval(load, 180_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (messages.length <= 1) return
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % messages.length)
    }, 5000)
    return () => clearInterval(timer)
  }, [messages.length])

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
      <Megaphone className="w-4 h-4 text-[var(--accent-warn)] shrink-0" />
      <span className="text-[var(--accent-warn)] text-xs font-medium shrink-0">
        播报
      </span>
      <span className="text-sm text-[var(--text-secondary)] truncate">
        {messages[index] ?? ""}
      </span>
    </div>
  )
}
