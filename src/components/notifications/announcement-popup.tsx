"use client"
import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAuthStore } from "@/stores/auth"
import { announcementScope, isAnnouncementDismissed, latestAnnouncement, setAnnouncementDismissed, type PublishedAnnouncement } from "@/lib/announcements"
import { formatShanghaiTime } from "@/lib/utils"

// Cleared on application restart; route changes or mode switching do not repeat a popup.
const checkedSessions = new Set<string>()
export function AnnouncementPopup(): React.JSX.Element | null {
  const userId = useAuthStore(s => s.user?.id)
  const token = useAuthStore(s => s.accessToken)
  const authenticated = Boolean(token)
  const [notice, setNotice] = useState<PublishedAnnouncement | null>(null)
  const [scope, setScope] = useState("")
  const [checked, setChecked] = useState(false)
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    setNotice(null); setChecked(false); setStorageError(false)
    if (!userId || !authenticated) return
    const key = announcementScope(userId)
    setScope(key)
    if (checkedSessions.has(key)) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    async function load(): Promise<void> {
      try {
        const { item } = await latestAnnouncement()
        if (cancelled) return
        checkedSessions.add(key)
        if (item && !isAnnouncementDismissed(key, item.id)) setNotice(item)
      } catch {
        if (!cancelled) retry = setTimeout(() => void load(), 30000)
      }
    }
    void load()
    return () => { cancelled = true; if (retry) clearTimeout(retry) }
  }, [userId, authenticated])
  if (!notice) return null
  return <Dialog open onOpenChange={open => { if (!open) setNotice(null) }}>
    <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" overlayClassName="z-[120]" style={{ zIndex: 121 }}>
      <DialogHeader><DialogTitle>最新公告 · {notice.title}</DialogTitle>
        <DialogDescription>{formatShanghaiTime(notice.published_at)} · 也可在消息中心的“公告”栏目查看。</DialogDescription>
      </DialogHeader>
      <div className="overflow-auto whitespace-pre-wrap break-words text-sm leading-7 text-[var(--text-secondary)]">{notice.content}</div>
      <div className="flex justify-end items-center flex-wrap gap-4 pt-3 border-t border-[var(--border)]">
        <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={checked} onChange={event => {
          const value = event.target.checked; setChecked(value)
          setStorageError(!setAnnouncementDismissed(scope, notice.id, value))
        }} />下次不再弹出</label>
        <Button onClick={() => setNotice(null)}>我知道了</Button>
      </div>
      {storageError && <p className="text-xs text-amber-400">本机未能保存选择，下次可能再次提示。</p>}
    </DialogContent>
  </Dialog>
}
