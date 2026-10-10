"use client"
import { useEffect, useState } from "react"
import { Heart, Upload, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { donationKinds, donationLabels, emptyDonations, getAdminDonations, readDonationImage, saveDonations, type DonationChannel, type DonationKind } from "@/lib/donations"

export function DonationsPage(): React.JSX.Element {
  const [config, setConfig] = useState(emptyDonations)
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<DonationKind | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  useEffect(() => {
    let cancelled = false
    void getAdminDonations().then(value => { if (!cancelled) { setConfig(value); setReady(true) } }).catch(e => { if (!cancelled) setError(e.message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  function patch(kind: DonationKind, values: Partial<DonationChannel>) {
    setConfig(prev => ({ ...prev, [kind]: { ...prev[kind], ...values } })); setNotice("")
  }
  async function upload(kind: DonationKind, file?: File) {
    if (!file) return
    setUploading(kind); setError("")
    try { patch(kind, { qr_image: await readDonationImage(file) }) }
    catch (e) { setError(e instanceof Error ? e.message : "读取图片失败") }
    finally { setUploading(null) }
  }
  async function save() {
    setSaving(true); setError(""); setNotice("")
    try { setConfig(await saveDonations(config)); setNotice("已保存，客户端将按上架状态显示打赏方式") }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败") }
    finally { setSaving(false) }
  }
  return <div className="p-6 max-w-5xl mx-auto space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold flex items-center gap-2"><Heart className="w-5 h-5 text-rose-400" />打赏管理</h1><p className="text-sm text-[var(--text-muted)] mt-2">设置客户端打赏入口及收款方式，二维码由管理员上传。</p></div><Button onClick={() => void save()} disabled={!ready || loading || saving || uploading !== null}><Save className="w-4 h-4 mr-2" />{saving ? "保存中…" : "保存设置"}</Button></div>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-400">{notice}</p>}
    {loading ? <p>加载配置…</p> : <fieldset disabled={saving || !ready} className="space-y-5">
      <label className="flex gap-3 items-center rounded-xl border border-[var(--border)] p-4"><input type="checkbox" checked={config.enabled} onChange={e => { setConfig(prev => ({ ...prev, enabled: e.target.checked })); setNotice("") }} /><span><span className="font-medium">开启打赏入口</span><span className="block text-xs text-[var(--text-muted)] mt-1">关闭后，客户端隐藏打赏按钮。各收款方式可独立上架。</span></span></label>
      <div className="grid gap-4 lg:grid-cols-3">{donationKinds.map(kind => <section key={kind} className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-4">
        <label className="flex justify-between items-center gap-3 font-medium">{donationLabels[kind]}<span className="flex items-center gap-2 text-xs"><input aria-label={`${donationLabels[kind]}上架`} type="checkbox" checked={config[kind].enabled} onChange={e => patch(kind, { enabled: e.target.checked })} />上架</span></label>
        <div className="aspect-square rounded-lg bg-white flex items-center justify-center overflow-hidden">{config[kind].qr_image ? <img src={config[kind].qr_image} alt={`${donationLabels[kind]}收款二维码预览`} className="w-full h-full object-contain p-2" /> : <span className="text-sm text-gray-400">尚未上传二维码</span>}</div>
        <label className="block text-sm space-y-2"><span className="flex items-center gap-2"><Upload className="w-4 h-4" />{uploading === kind ? "读取图片…" : "上传收款二维码"}</span><input aria-label={`${donationLabels[kind]}二维码`} type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading !== null} className="block text-xs max-w-full" onChange={e => { void upload(kind, e.target.files?.[0]); e.target.value = "" }} /></label>
        <p className="text-xs text-[var(--text-muted)]">PNG / JPEG / WebP，最大 2MB。</p>
        {config[kind].qr_image && <button type="button" className="text-xs text-red-400" disabled={uploading !== null} onClick={() => patch(kind, { qr_image: "" })}>移除二维码</button>}
        {kind === "crypto" && <div className="space-y-3"><label className="block text-xs space-y-1"><span>收款地址</span><Input value={config.crypto.address} maxLength={512} placeholder="填写虚拟币收款地址" onChange={e => patch(kind, { address: e.target.value })} /></label><label className="block text-xs space-y-1"><span>币种</span><Input value={config.crypto.currency} maxLength={40} placeholder="例如 USDT" onChange={e => patch(kind, { currency: e.target.value })} /></label><label className="block text-xs space-y-1"><span>收款网络</span><Input value={config.crypto.network} maxLength={80} placeholder="例如 TRC20 / ERC20" onChange={e => patch(kind, { network: e.target.value })} /></label><p className="text-xs text-[var(--text-muted)]">二维码、地址至少填写一项，也可同时提供。</p></div>}
      </section>)}</div>
    </fieldset>}
  </div>
}
