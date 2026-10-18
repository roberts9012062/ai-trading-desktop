"use client"
import {useEffect,useState,useSyncExternalStore} from 'react'
import {KeyRound,ExternalLink,CheckCircle2,RefreshCw,Trash2} from 'lucide-react'
import {Input} from '@/components/ui/input'
import {Button} from '@/components/ui/button'
import {Card,CardContent} from '@/components/ui/card'
import {collectionStatus,onCollectionChange,loadCollectionConfig,collectionKeyAction,refreshCollectionPermissions,nativeCollection,COLLECTION_BASE,type CollectionStatus} from '@/lib/collection-config'

const labels:Record<string,string>={history:'历史K线',quotes:'报价快照',ticks:'最近成交',stream_bars:'实时K线',stream_quotes:'实时报价与盘口',stream_ticks:'逐笔成交'}

export function DataConfigPanel(){
  const saved=useSyncExternalStore(onCollectionChange,collectionStatus,collectionStatus)
  const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[checked,setChecked]=useState<CollectionStatus|null>(null)
  useEffect(()=>{void loadCollectionConfig().then(s=>{if(s.configured)void refreshCollectionPermissions().catch(e=>setMessage(String(e)))})},[])
  const act=async(action:'test'|'save'|'clear')=>{
    setBusy(true);setMessage('')
    try{
      const result=await collectionKeyAction(action,key)
      setChecked(result)
      if(action==='test')setMessage('检测通过，请保存后使用')
      else {setKey('');setMessage(action==='clear'?'Key 已清除':'配置已保存，正在重新连接行情');if(nativeCollection())window.location.reload()}
    }catch(e){setMessage(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  const grants=(checked?.permissions??saved.permissions)?.active_packages.filter(g=>g.markets.includes('crypto'))||[]
  return <div className="max-w-2xl space-y-5">
    <div><h2 className="text-lg font-semibold">数据配置</h2><p className="mt-1 text-sm text-[var(--text-muted)]">接入你的加密货币行情服务，统一获取 K 线、实时报价、盘口和成交。</p></div>
    <Card><CardContent className="p-5 space-y-5">
      <div className="flex items-center justify-between"><div className="flex gap-3 items-center"><KeyRound className="w-5 h-5 text-[var(--primary)]"/><div><p className="font-medium">API Value Collection</p><p className="text-xs text-[var(--text-muted)]">OKX USDT 永续 · {COLLECTION_BASE}</p></div></div><span className="text-xs text-[var(--text-muted)]">{saved.configured?'已配置':'待配置'}</span></div>
      <div className="flex gap-4 text-sm"><a className="text-[var(--primary)] inline-flex gap-1 items-center" href={COLLECTION_BASE} target="_blank" rel="noreferrer">获取 API Key<ExternalLink className="w-3 h-3"/></a><a className="text-[var(--primary)]" href={COLLECTION_BASE+'/#docs'} target="_blank" rel="noreferrer">接口帮助文档</a></div>
      <div><label htmlFor="market-data-key" className="block text-sm mb-2">API Key</label><Input id="market-data-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={e=>{setKey(e.target.value);setChecked(null)}} placeholder={saved.masked?`当前：${saved.masked}，输入可替换`:'填写从接口中心获取的 ac_ 开头 Key'}/><p className="text-xs mt-2 text-[var(--text-muted)]">{nativeCollection()?'Key 由 Windows 系统加密保存在本机，按桌面账号隔离。':'浏览器调试仅在当前页面内保存，刷新后需重新填写。'}</p></div>
      <div className="flex gap-2 flex-wrap"><Button variant="outline" disabled={busy||!key.trim()} onClick={()=>void act('test')}><CheckCircle2 className="h-4 w-4 mr-1"/>检测连接</Button><Button disabled={busy||!key.trim()} onClick={()=>void act('save')}>{busy?<RefreshCw className="h-4 w-4 animate-spin mr-1"/>:null}保存配置</Button>{saved.configured&&<Button variant="ghost" disabled={busy} onClick={()=>void act('clear')}><Trash2 className="h-4 w-4 mr-1"/>清除</Button>}</div>
      {saved.lastMarketAt&&<p className="text-xs text-[var(--text-muted)]">最近行情：{new Date(saved.lastMarketAt).toLocaleTimeString('zh-CN',{hour12:false})}</p>}
      {(message||saved.error)&&<p role="status" className="text-sm text-[var(--text-secondary)] break-words">{message||saved.error}</p>}
    </CardContent></Card>
    {grants.map((grant,i)=><Card key={i}><CardContent className="p-5 text-sm space-y-3"><div className="flex justify-between"><span className="font-medium">加密货币行情授权</span><span>到期：{new Date(grant.expires_at).toLocaleString('zh-CN',{hour12:false})}</span></div><p className="text-[var(--text-secondary)]">{grant.rpm} 次/分钟 · 最多 {grant.connections} 个连接 · {grant.market_subscriptions?.crypto??'—'} 个合约</p><p className="text-xs text-[var(--text-muted)] break-words">可用能力：{grant.capabilities.map(c=>labels[c]||c).join(' / ')}</p></CardContent></Card>)}
    <p className="text-xs leading-6 text-[var(--text-muted)]">行情 Key 与交易所下单凭证独立。可用数据以套餐权限为准；网络重连可能造成逐笔缺口。长期研究与回测历史使用独立研究渠道。</p>
  </div>
}

export function DataConfigNotice(){
  const saved=useSyncExternalStore(onCollectionChange,collectionStatus,collectionStatus)
  if(saved.configured&&!saved.error)return null
  return <div className="px-4 py-2 text-xs border-b border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]"><a href="/profile?tab=data" className="text-[var(--primary)] mr-2">数据配置</a>{saved.error||'填写你的行情 API Key，即可接入加密货币实时行情。'}</div>
}
