"use client"
import { useEffect, useState } from "react"
import { ArrowLeft, Check, Copy, Heart } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getDonations, type DonationKind, type PublicDonations } from "@/lib/donations"

export function DonationButton(): React.JSX.Element | null {
  const [data, setData] = useState<PublicDonations>({ enabled: false, channels: [] })
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<DonationKind | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      if (open) setLoading(true)
      void getDonations().then(value => {
        if (cancelled) return
        setData(value); setError("")
        setSelected(prev => value.channels.some(c => c.kind === prev) ? prev : null)
      }).catch(() => { if (!cancelled) { setData({ enabled: false, channels: [] }); setError("打赏方式暂时无法加载，请稍后重试") } }).finally(() => { if (!cancelled) setLoading(false) })
    }
    refresh()
    const timer = setInterval(refresh, open ? 10000 : 30000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [open])
  const channel = data.channels.find(c => c.kind === selected)
  async function copyAddress() {
    if (!channel?.address) return
    try { await navigator.clipboard.writeText(channel.address); setCopied(true) }
    catch { setError("复制失败，请长按或选中地址手动复制") }
  }
  if (!open && !data.enabled) return null
  return <>
    {data.enabled && <button onClick={() => { setSelected(null); setCopied(false); setOpen(true) }} className="fixed bottom-6 right-24 z-40 flex items-center gap-2 rounded-full border border-rose-400/30 bg-[var(--bg-secondary)] px-4 py-2 text-sm text-rose-300 shadow-lg hover:bg-rose-400/10 transition-colors" aria-label="打赏"><Heart className="h-4 w-4" />打赏</button>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-md max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle className="flex items-center gap-2"><Heart className="w-5 h-5 text-rose-400" />{channel?.label ?? "支持 CyclePilot"}</DialogTitle><DialogDescription>感谢你的支持，选择一种方式打赏。</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {loading && !data.enabled ? <p className="text-sm">加载打赏方式…</p> : !data.enabled ? <p className="text-sm text-[var(--text-muted)]">打赏暂未开放。</p> : channel ? <div className="space-y-4">
        <button className="flex items-center gap-1 text-xs text-[var(--text-muted)]" onClick={() => { setSelected(null); setCopied(false); setError("") }}><ArrowLeft className="w-3 h-3" />选择其他方式</button>
        {channel.qr_image && <div className="rounded-xl bg-white p-3"><img src={channel.qr_image} alt={`${channel.label}收款二维码`} className="mx-auto max-h-80 w-full object-contain" /></div>}
        {(channel.currency || channel.network) && <p className="text-sm text-center">{[channel.currency, channel.network].filter(Boolean).join(" · ")}</p>}
        {channel.address && <div className="space-y-2"><p className="text-xs text-[var(--text-muted)]">收款地址</p><p className="break-all select-all rounded-md border border-[var(--border)] p-3 text-sm font-mono">{channel.address}</p><Button variant="outline" className="w-full" onClick={() => void copyAddress()}>{copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}{copied ? "已复制地址" : "复制地址"}</Button></div>}
      </div> : <div className="space-y-3">{data.channels.map(c => <button key={c.kind} className="w-full text-left rounded-xl border border-[var(--border)] p-4 hover:border-rose-400/50 hover:bg-rose-400/5 transition-colors" onClick={() => { setSelected(c.kind); setCopied(false) }}><span className="font-medium">{c.label}</span><span className="block text-xs text-[var(--text-muted)] mt-1">{c.kind === "crypto" ? [c.currency, c.network].filter(Boolean).join(" · ") || "二维码或收款地址" : "扫码打赏"}</span></button>)}</div>}
    </DialogContent></Dialog>
  </>
}
