"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { listAnnouncements, publishAnnouncement, withdrawAnnouncement, parseAnnouncementAudience, type PublishedAnnouncement } from "@/lib/announcements"
import { formatShanghaiTime } from "@/lib/utils"

export default function AdminAnnouncementsPage(): React.JSX.Element {
  const [items, setItems] = useState<PublishedAnnouncement[]>([])
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [audience, setAudience] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  async function refresh(): Promise<void> { setItems(await listAnnouncements(true)) }
  useEffect(() => { void refresh().catch(e => setError(e instanceof Error ? e.message : "加载失败")) }, [])
  async function publish(): Promise<void> {
    if (!title.trim() || !content.trim()) { setError("请填写公告标题和正文"); return }
    setBusy(true); setError(""); setMessage("")
    try { await publishAnnouncement(title.trim(), content.trim(), parseAnnouncementAudience(audience)); setTitle(""); setContent(""); setAudience(""); setMessage("公告已发布，仅向所选接收范围展示；在线新版客户端会自动弹出，离线用户下次登录可见。"); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : "发布失败") }
    finally { setBusy(false) }
  }
  async function withdraw(id: string): Promise<void> {
    setBusy(true); setError(""); setMessage("")
    try { await withdrawAnnouncement(id); setMessage("公告已撤回"); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : "撤回失败") }
    finally { setBusy(false) }
  }
  return <div className="max-w-4xl mx-auto p-4 space-y-4">
    <h1 className="text-lg font-semibold">公告管理</h1>
    <p className="text-xs text-[var(--text-muted)]">启动时展示最新已发布公告。用户忽略旧公告后，新公告仍会弹出；历史公告可在消息中心查看。每次发布都会生成新公告。</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}{message && <p role="status" className="text-sm text-up">{message}</p>}
    <Card><CardContent className="p-4 space-y-3">
      <label className="block text-sm space-y-1"><span>公告标题</span><input aria-label="公告标题" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} className="block w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2" /></label>
      <label className="block text-sm space-y-1"><span>定向接收用户名（留空为全体用户）</span><input aria-label="定向接收用户名" value={audience} onChange={e => setAudience(e.target.value)} placeholder="例如：none, none2, qy123" className="block w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2" /></label>
      <label className="block text-sm space-y-1"><span>公告正文</span><textarea aria-label="公告正文" maxLength={20000} rows={8} value={content} onChange={e => setContent(e.target.value)} className="block w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 resize-y" /></label>
      <div className="flex justify-end"><Button disabled={busy} onClick={() => void publish()}>{busy ? "处理中…" : "发布公告"}</Button></div>
    </CardContent></Card>
    <div className="space-y-3">{items.map(item => <Card key={item.id}><CardContent className="p-4">
      <div className="flex items-start gap-3 justify-between"><h2 className="text-sm font-medium break-words">{item.title}</h2><span className="text-xs shrink-0 text-[var(--text-muted)]">{item.published ? "已发布" : "已撤回"}</span></div>
      <p className="text-xs text-[var(--text-muted)] mt-1">{formatShanghaiTime(item.published_at)}</p>
      <p className="text-xs text-[var(--text-muted)] mt-1">接收范围：{item.target_usernames ? item.target_usernames.join("、") : "全体用户"}</p>
      <p className="whitespace-pre-wrap break-words text-sm leading-7 mt-3">{item.content}</p>
      {item.published && <div className="flex justify-end mt-3"><Button disabled={busy} size="sm" variant="outline" onClick={() => void withdraw(item.id)}>撤回公告</Button></div>}
    </CardContent></Card>)}{!items.length && <p className="text-sm text-[var(--text-muted)]">暂无已发布公告</p>}</div>
  </div>
}
