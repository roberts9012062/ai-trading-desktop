import {useEffect,useState,useRef} from 'react'
import {RefreshCw,Database} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {Card,CardContent} from '@/components/ui/card'
import {useAuthStore} from '@/stores/auth'
import {nativeCollection} from '@/lib/collection-config'
import {localSyncStatus,localSyncConflicts,resolveSyncConflict,syncDesktopRecords,type SyncStatus,type RecordConflict} from '@/lib/local-records'

const label=(record:RecordConflict)=>record.collection==='watchlist'?'自选合约':'通知设置'
function summary(collection:string,value:Record<string,unknown>){
  if(collection==='watchlist')return `合约：${String(value.contract_symbol||'').toUpperCase()}\n名称：${value.contract_name||'—'}\n分组：${value.group_name||'未分组'}\n排序：${Number(value.sort_order??0)+1}`
  const labels:Record<string,string>={notify_trade:'成交通知',notify_fund:'资金变动通知',notify_price_alert:'价格提醒',notify_sound_enabled:'提示音'}
  return Object.entries(labels).map(([key,name])=>`${name}：${value[key]===false?'关闭':'开启'}`).join('\n')
}
export function ServerSyncPanel(){
  const owner=useAuthStore(state=>state.user?`${state.user.id}:${state.user.trading_mode}`:'')
  const [status,setStatus]=useState<SyncStatus>({pending:0,conflicts:0})
  const [conflicts,setConflicts]=useState<RecordConflict[]>([])
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const currentOwner=useRef(owner),mounted=useRef(false)
  currentOwner.current=owner
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  useEffect(()=>{
    let active=true
    setBusy(false);setMessage('');setConflicts([]);setStatus({pending:0,conflicts:0})
    if(nativeCollection())void Promise.all([localSyncStatus(),localSyncConflicts()]).then(([state,rows])=>{if(active){setStatus(state);setConflicts(rows)}}).catch(error=>{if(active)setMessage(error instanceof Error?error.message:'本机同步状态读取失败')})
    const changed=()=>{void localSyncStatus().then(state=>{if(active)setStatus(state)}).catch(()=>{})}
    window.addEventListener('desktop-records-changed',changed)
    return()=>{active=false;window.removeEventListener('desktop-records-changed',changed)}
  },[owner])
  if(!nativeCollection())return null
  const active=()=>mounted.current&&currentOwner.current===owner
  async function refresh(){const [state,rows]=await Promise.all([localSyncStatus(),localSyncConflicts()]);if(active()){setStatus(state);setConflicts(rows)}}
  async function sync(){
    if(busy)return
    setBusy(true);setMessage('')
    try{
      const result=await syncDesktopRecords()
      await refresh()
      if(!active())return
      setMessage(result.conflicts?`同步完成，${result.conflicts} 条冲突待选择；本机修改已保留。`:`同步完成，已上传 ${result.uploaded} 条修改。`)
      window.dispatchEvent(new Event('desktop-record-sync'))
    }catch(error){if(active())setMessage(error instanceof Error?error.message:'服务器暂时无法连接，本机记录已保留')}
    finally{if(active())setBusy(false)}
  }
  async function resolve(row:RecordConflict,choice:'local'|'server'){
    if(busy)return
    setBusy(true)
    try{await resolveSyncConflict(row,choice);await refresh();if(active()){setMessage(choice==='local'?'已保留本机版本，请再次同步服务器。':'已采用服务器版本。');window.dispatchEvent(new Event('desktop-record-sync'))}}
    catch(error){if(active())setMessage(error instanceof Error?error.message:'冲突处理失败')}
    finally{if(active())setBusy(false)}
  }
  return <Card><CardContent className="p-5 space-y-4">
    <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 font-medium"><Database className="h-4 w-4"/>本机数据与服务器同步</div><Button disabled={busy||!owner} onClick={()=>void sync()}><RefreshCw className={`h-4 w-4 mr-1 ${busy?'animate-spin':''}`}/>{busy?'同步中…':'同步服务器'}</Button></div>
    <p className="text-sm text-[var(--text-secondary)]">自选合约和通知设置保存在本机 SQLite，服务器断开时仍可修改。同步时合并两端数据，有冲突时由你选择。</p>
    <p className="text-xs text-[var(--text-muted)]">待上传 {status.pending} 条 · 待处理冲突 {status.conflicts} 条 · 最近同步：{status.sync?.at?new Date(status.sync.at).toLocaleString('zh-CN',{hour12:false}):'尚未同步'}</p>
    <p className="text-xs text-[var(--text-muted)]">首次使用请同步一次服务器，导入原有自选和通知设置。此处同步不会创建或启动交易任务。</p>
    {message&&<p role="status" className="text-sm break-words">{message}</p>}
    {conflicts.map(row=><div key={`${row.collection}:${row.id}`} className="rounded-md border border-[var(--border)] p-3 space-y-2 text-xs">
      <p className="font-medium">{label(row)} · {String(row.local?.value.contract_name||(row.id==='current'?'通知设置':row.id))}</p>
      <div className="grid gap-2 md:grid-cols-2"><div><p>本机版本</p><p className="mt-1 whitespace-pre-wrap break-all text-[var(--text-muted)]">{row.local?.deleted?'已删除':summary(row.collection,row.local?.value??{})}</p></div><div><p>服务器版本</p><p className="mt-1 whitespace-pre-wrap break-all text-[var(--text-muted)]">{row.remote.deleted?'已删除':summary(row.collection,row.remote.value)}</p></div></div>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={()=>void resolve(row,'local')}>保留本机</Button><Button size="sm" variant="outline" disabled={busy} onClick={()=>void resolve(row,'server')}>采用服务器</Button></div>
    </div>)}
  </CardContent></Card>
}
