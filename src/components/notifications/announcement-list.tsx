"use client"
import { useEffect, useState } from "react"
import { listAnnouncements, type PublishedAnnouncement } from "@/lib/announcements"
import { formatShanghaiTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export function AnnouncementList(): React.JSX.Element {
  const [items, setItems] = useState<PublishedAnnouncement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  async function load(): Promise<void> {
    try { setItems(await listAnnouncements()); setError("") }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败") }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let active = true
    async function refresh(): Promise<void> {
      try { const rows = await listAnnouncements(); if (active) { setItems(rows); setError("") } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : "加载失败") }
      finally { if (active) setLoading(false) }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 30000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  return <div className="flex-1 overflow-auto p-4 space-y-3" aria-label="公告列表">
    {error && <div className="flex items-center gap-3 text-sm text-amber-400">{error}<Button size="sm" onClick={() => void load()}>重试</Button></div>}
    {loading ? <p className="text-sm">加载公告中…</p> : !items.length && !error ? <p className="text-sm text-[var(--text-muted)]">暂无公告</p> : null}
    {items.map((item, index) => <details key={item.id} open={index === 0} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <summary className="cursor-pointer font-medium text-sm break-words">{item.title}<span className="ml-3 text-xs font-normal text-[var(--text-muted)]">{formatShanghaiTime(item.published_at)}</span></summary>
      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7 text-[var(--text-secondary)]">{item.content}</p>
    </details>)}
  </div>
}
