"use client"
import {serverAccountMode,setAccountTransport} from '@/lib/account-transport'
import {collectionMode,nativeCollection} from '@/lib/collection-config'
import {Button} from '@/components/ui/button'
export function AccountSourceSelector(){
  if(!nativeCollection()||!collectionMode())return null
  const server=serverAccountMode()
  const select=(mode:'standalone'|'server')=>{setAccountTransport(mode);window.location.reload()}
  return <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
    <p className="text-sm font-medium">个人实盘账户来源</p>
    <div className="flex gap-2"><Button size="sm" variant={server?'outline':'default'} aria-pressed={!server} onClick={()=>select('standalone')}>单机模式</Button><Button size="sm" variant={server?'default':'outline'} aria-pressed={server} onClick={()=>select('server')}>服务器模式</Button></div>
    <p className="text-xs text-[var(--text-muted)]">{server?'使用业务服务器保存的账户并由服务器查询，需配置可用的业务服务器地址。':'在本机配置 OKX 凭证并加密保存，账户查询通过 API VALUE COLLECTION；无接口中心 Key 时直连 OKX。不依赖业务服务器，配置账户不会开通交易或任务权限。'}</p>
  </div>
}
