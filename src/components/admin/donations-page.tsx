"use client"
import { useEffect, useState } from "react"
import { Heart, Plus, Save, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { donationLabels, emptyDonations, getAdminDonations, newDonationChain, readDonationImage, saveDonations, type DonationChain, type DonationChannel } from "@/lib/donations"

function QrEditor({label,value,disabled,onUpload,onRemove}:{label:string;value:string;disabled:boolean;onUpload:(file?:File)=>void;onRemove:()=>void}) {
  return <div className="space-y-3"><div className="h-44 w-44 mx-auto rounded-xl bg-white flex items-center justify-center overflow-hidden">{value ? <img src={value} alt={`${label}收款二维码预览`} className="w-full h-full object-contain p-2" /> : <span className="text-xs text-gray-400">尚未上传二维码</span>}</div><label className="block text-xs space-y-2"><span className="flex items-center gap-2"><Upload className="w-3 h-3" />上传收款二维码</span><input aria-label={`${label}二维码`} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} className="block text-xs max-w-full" onChange={e=>{onUpload(e.target.files?.[0]);e.target.value=""}} /></label>{value&&<button type="button" disabled={disabled} className="text-xs text-red-400" onClick={onRemove}>移除二维码</button>}</div>
}

export function DonationsPage(): React.JSX.Element {
  const [config,setConfig]=useState(emptyDonations)
  const [loading,setLoading]=useState(true)
  const [ready,setReady]=useState(false)
  const [saving,setSaving]=useState(false)
  const [uploading,setUploading]=useState(false)
  const [error,setError]=useState("")
  const [notice,setNotice]=useState("")
  useEffect(()=>{let cancelled=false;void getAdminDonations().then(value=>{if(!cancelled){setConfig(value);setReady(true)}}).catch(e=>{if(!cancelled)setError(e.message)}).finally(()=>{if(!cancelled)setLoading(false)});return()=>{cancelled=true}},[])
  function patch(kind:"crypto"|"wechat"|"alipay",values:Partial<DonationChannel>) {setConfig(prev=>({...prev,[kind]:{...prev[kind],...values}}));setNotice("")}
  function chainPatch(id:string,values:Partial<DonationChain>) {setConfig(prev=>({...prev,crypto_chains:prev.crypto_chains.map(c=>c.id===id?{...c,...values}:c)}));setNotice("")}
  async function upload(file:File|undefined,apply:(value:string)=>void) {if(!file)return;setUploading(true);setError("");try{apply(await readDonationImage(file))}catch(e){setError(e instanceof Error?e.message:"读取图片失败")}finally{setUploading(false)}}
  async function save() {setSaving(true);setError("");setNotice("");try{setConfig(await saveDonations(config));setNotice("已保存，客户端将按上架状态显示打赏方式")}catch(e){setError(e instanceof Error?e.message:"保存失败")}finally{setSaving(false)}}
  return <div className="p-6 max-w-5xl mx-auto space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold flex items-center gap-2"><Heart className="w-5 h-5 text-rose-400" />打赏管理</h1><p className="text-sm text-[var(--text-muted)] mt-2">虚拟币按链配置收款信息，用户选择链后查看对应二维码和地址。</p></div><Button onClick={()=>void save()} disabled={!ready||loading||saving||uploading}><Save className="w-4 h-4 mr-2" />{saving?"保存中…":"保存设置"}</Button></div>
    {error&&<p role="alert" className="text-sm text-red-400">{error}</p>}{notice&&<p role="status" className="text-sm text-emerald-400">{notice}</p>}
    {loading?<p>加载配置…</p>:<fieldset disabled={saving||!ready||uploading} className="space-y-5">
      <label className="flex gap-3 items-center rounded-xl border border-[var(--border)] p-4"><input type="checkbox" checked={config.enabled} onChange={e=>{setConfig(prev=>({...prev,enabled:e.target.checked}));setNotice("")}} /><span><span className="font-medium">开启打赏入口</span><span className="block text-xs text-[var(--text-muted)] mt-1">总开关关闭后客户端隐藏入口，收款信息仍保留。</span></span></label>
      <section className="rounded-xl border border-[var(--border)] p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 font-medium"><input aria-label="虚拟币打赏上架" type="checkbox" checked={config.crypto.enabled} onChange={e=>patch("crypto",{enabled:e.target.checked})} />虚拟币打赏</label><Button variant="outline" disabled={config.crypto_chains.length>=20} onClick={()=>{setConfig(prev=>({...prev,crypto_chains:[...prev.crypto_chains,newDonationChain()]}));setNotice("")}}><Plus className="w-4 h-4 mr-1" />添加虚拟链</Button></div>
        <p className="text-xs text-[var(--text-muted)]">支持 Ethereum（ETH / ERC20）、Tron（TRC20）、OKT Chain 等自定义链，最多 20 条。每条链可仅填地址、仅上传二维码或同时提供。</p>
        {!config.crypto_chains.length&&<p className="text-sm py-6 text-center text-[var(--text-muted)]">还没有虚拟链，点击「添加虚拟链」配置收款。</p>}
        {config.crypto_chains.map((chain,index)=><article key={chain.id} aria-label={`虚拟链 ${index+1}`} className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] p-4 space-y-4">
          <div className="flex justify-between items-center gap-3"><h2 className="text-sm font-medium">{chain.network||`新虚拟链 ${index+1}`}</h2><div className="flex items-center gap-4"><label className="flex gap-2 items-center text-xs"><input aria-label={`虚拟链 ${index+1}上架`} type="checkbox" checked={chain.enabled} onChange={e=>chainPatch(chain.id,{enabled:e.target.checked})} />上架此链</label><button type="button" aria-label={`删除虚拟链 ${index+1}`} className="text-[var(--text-muted)] hover:text-red-400" onClick={()=>{setConfig(prev=>{const rows=prev.crypto_chains.filter(c=>c.id!==chain.id);return {...prev,crypto_chains:rows,crypto:rows.length?prev.crypto:emptyDonations().crypto}});setNotice("")}}><Trash2 className="w-4 h-4" /></button></div></div>
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_220px]"><div className="space-y-4"><label className="block text-xs space-y-1"><span>链名称 / 收款网络</span><Input value={chain.network} maxLength={80} placeholder="例如 Ethereum（ERC20）" onChange={e=>chainPatch(chain.id,{network:e.target.value})} /></label><label className="block text-xs space-y-1"><span>币种（可选）</span><Input value={chain.currency} maxLength={40} placeholder="例如 USDT / ETH" onChange={e=>chainPatch(chain.id,{currency:e.target.value})} /></label><label className="block text-xs space-y-1"><span>收款地址</span><Input value={chain.address} maxLength={512} placeholder="填写该链收款地址" onChange={e=>chainPatch(chain.id,{address:e.target.value})} /></label></div><QrEditor label={`虚拟链 ${index+1}`} value={chain.qr_image} disabled={uploading} onUpload={file=>void upload(file,value=>chainPatch(chain.id,{qr_image:value}))} onRemove={()=>chainPatch(chain.id,{qr_image:""})} /></div>
        </article>)}
      </section>
      <div className="grid gap-4 md:grid-cols-2">{(["wechat","alipay"] as const).map(kind=><section key={kind} className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-4"><label className="flex justify-between items-center gap-3 font-medium">{donationLabels[kind]}<span className="flex items-center gap-2 text-xs"><input aria-label={`${donationLabels[kind]}上架`} type="checkbox" checked={config[kind].enabled} onChange={e=>patch(kind,{enabled:e.target.checked})} />上架</span></label><QrEditor label={donationLabels[kind]} value={config[kind].qr_image} disabled={uploading} onUpload={file=>void upload(file,value=>patch(kind,{qr_image:value}))} onRemove={()=>patch(kind,{qr_image:""})} /></section>)}</div>
      <p className="text-xs text-[var(--text-muted)]">二维码支持 PNG / JPEG / WebP，单张最大 2MB，全部图片合计最大 6MB。确认二维码与收款地址对应同一条链后保存。</p>
    </fieldset>}
  </div>
}
