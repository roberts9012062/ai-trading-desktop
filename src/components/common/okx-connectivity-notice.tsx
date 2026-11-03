import {useEffect,useSyncExternalStore} from 'react'
import {Link} from 'react-router-dom'
import {okxConnectivityStatus,onOkxConnectivityChange,clearOkxConnectivity} from '@/lib/okx-connectivity'
import {onCollectionChange} from '@/lib/collection-config'
import {hostSession,onHostSessionChange} from '@/lib/taskhost-client'
export function OkxConnectivityNotice(){
 const status=useSyncExternalStore(onOkxConnectivityChange,okxConnectivityStatus,okxConnectivityStatus),session=useSyncExternalStore(onHostSessionChange,hostSession,()=>null)
 useEffect(()=>onCollectionChange(clearOkxConnectivity),[])
 if(!status.warnings.length)return null
 const direct=status.warnings.some(w=>w.source==='direct')
 return <aside role="alert" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-400 space-y-2">
  <p>{direct?'无法连接 OKX 数据。可配置或购买 API Collection Key，或同步当前本地 Key。':'API Collection 数据暂时无法连接，请核对网络、Key 和套餐权限；不会自动绕过已配置的接口中心。'}余额与持仓可能是旧记录，不能视为当前账户状态。</p>
  <div className="flex flex-wrap gap-4"><Link className="underline" to={session?.mode==='server'?'/task-hosting#client-data-sync':'/profile?tab=data'}>{session?.mode==='server'?'同步当前本地配置':'打开数据配置'}</Link><a className="underline" href="https://lium.eu.org/" target="_blank" rel="noreferrer">配置 / 购买 API Collection Key</a></div>
 </aside>
}
