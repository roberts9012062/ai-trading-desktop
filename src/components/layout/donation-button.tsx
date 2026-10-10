"use client"
import { useEffect, useState } from "react"
import { ArrowLeft, Check, Copy, Heart } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getDonations, listedChains, type DonationKind, type PublicDonations } from "@/lib/donations"

export function DonationButton(): React.JSX.Element | null {
  // Unknown/loading is different from an explicit administrator shutdown.
  const [data, setData] = useState<PublicDonations | null>(null)
  const [retry, setRetry] = useState(0)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<DonationKind | null>(null)
  const [chainId, setChainId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [copyError, setCopyError] = useState("")
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let cancelled = false
    let pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      setLoading(true)
      void getDonations().then(value => {
        if (cancelled) return
        setData(value); setError("")
        setSelected(prev => value.channels.some(c => c.kind === prev) ? prev : null)
        setChainId(prev => listedChains(value.channels.find(c => c.kind === "crypto")).some(c => c.id === prev) ? prev : null)
      }).catch(() => { if (!cancelled) setError("打赏方式暂时无法加载，请检查网络后重试") }).finally(() => { pending = false; if (!cancelled) setLoading(false) })
    }
    refresh()
    const timer = setInterval(refresh, open ? 10000 : 30000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [open, retry])
  const channel = data?.channels.find(c => c.kind === selected)
  const chains = listedChains(channel)
  const payment = channel?.kind === "crypto" ? chains.find(c => c.id === chainId) : channel
  useEffect(() => { setCopied(false); setCopyError("") }, [payment?.address])
  async function copyAddress() {
    if (!payment?.address) return
    try { await navigator.clipboard.writeText(payment.address); setCopied(true); setCopyError("") }
    catch { setCopyError("复制失败，请长按或选中地址手动复制") }
  }
  if (!open && data?.enabled === false) return null
  return <>
    {!open && data?.enabled !== false && <button type="button" onClick={() => { setSelected(null); setChainId(null); setCopied(false); setOpen(true) }} className="fixed bottom-6 right-24 z-[95] flex items-center gap-2 rounded-full border border-rose-400/30 bg-[var(--bg-secondary)] px-4 py-2 text-sm text-rose-300 shadow-lg hover:bg-rose-400/10 transition-colors" aria-label="打赏"><Heart className="h-4 w-4" />打赏</button>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent overlayClassName="z-[110]" className="z-[111] max-w-md max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle className="flex items-center gap-2"><Heart className="w-5 h-5 text-rose-400" />{channel?.kind === "crypto" && payment ? payment.network : channel?.label ?? "支持 CyclePilot"}</DialogTitle><DialogDescription>{channel?.kind === "crypto" ? payment ? "请使用下方所示收款网络与币种。" : "选择打赏链，查看对应二维码和收款地址。" : "感谢你的支持，选择一种方式打赏。"}</DialogDescription></DialogHeader>
      {error ? <div className="space-y-3"><p role="alert" className="text-sm text-red-400">{error}</p><Button variant="outline" disabled={loading} onClick={() => setRetry(value => value + 1)}>{loading ? "正在重试…" : "重新加载"}</Button></div> : !data ? <p role="status" className="text-sm">加载打赏方式…</p> : !data.enabled ? <p className="text-sm text-[var(--text-muted)]">打赏暂未开放。</p> : payment ? <div className="space-y-4">
        <button className="flex items-center gap-1 text-xs text-[var(--text-muted)]" onClick={() => { if(channel?.kind === "crypto")setChainId(null);else setSelected(null);setCopied(false);setError("") }}><ArrowLeft className="w-3 h-3" />{channel?.kind === "crypto" ? "选择其他链" : "选择其他方式"}</button>
        {copyError && <p role="alert" className="text-sm text-red-400">{copyError}</p>}
        {payment.qr_image && <div className="rounded-xl bg-white p-3"><img src={payment.qr_image} alt={`${channel?.kind === "crypto" ? payment.network : channel?.label}收款二维码`} className="mx-auto max-h-80 w-full object-contain" /></div>}
        {(payment.currency || payment.network) && <p className="text-sm text-center">{[payment.currency, payment.network].filter(Boolean).join(" · ")}</p>}
        {payment.address && <div className="space-y-2"><p className="text-xs text-[var(--text-muted)]">收款地址</p><p className="break-all select-all rounded-md border border-[var(--border)] p-3 text-sm font-mono">{payment.address}</p><Button variant="outline" className="w-full" onClick={() => void copyAddress()}>{copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}{copied ? "已复制地址" : "复制地址"}</Button></div>}
      </div> : channel?.kind === "crypto" ? <div className="space-y-3"><button className="flex items-center gap-1 text-xs text-[var(--text-muted)]" onClick={()=>{setSelected(null);setError("")}}><ArrowLeft className="w-3 h-3" />选择其他方式</button>{chains.map(c=><button key={c.id} className="w-full text-left rounded-xl border border-[var(--border)] p-4 hover:border-rose-400/50 hover:bg-rose-400/5" onClick={()=>{setChainId(c.id);setCopied(false);setError("")}}><span className="font-medium">{c.network}</span>{c.currency&&<span className="block mt-1 text-xs text-[var(--text-muted)]">{c.currency}</span>}</button>)}</div> : <div className="space-y-3">{data.channels.map(c => <button key={c.kind} className="w-full text-left rounded-xl border border-[var(--border)] p-4 hover:border-rose-400/50 hover:bg-rose-400/5 transition-colors" onClick={() => { setSelected(c.kind); setChainId(null); setCopied(false) }}><span className="font-medium">{c.label}</span><span className="block text-xs text-[var(--text-muted)] mt-1">{c.kind === "crypto" ? `${listedChains(c).length} 条收款链 · 选择网络` : "扫码打赏"}</span></button>)}</div>}
    </DialogContent></Dialog>
  </>
}
