import {useEffect,useState,useSyncExternalStore} from 'react'
import {collectionStatus,onCollectionChange,loadCollectionConfig,refreshCollectionPermissions} from '@/lib/collection-config'
import {collectionChartWarmupStatus,onCollectionChartWarmup} from '@/lib/collection-chart-cache'
import {directOkxMode} from '@/lib/market-provider'

export function CollectionServiceStatus({account=false}:{account?:boolean}){
  const status=useSyncExternalStore(onCollectionChange,collectionStatus,collectionStatus)
  const cache=useSyncExternalStore(onCollectionChartWarmup,collectionChartWarmupStatus,collectionChartWarmupStatus)
  const [,tick]=useState(0)
  useEffect(()=>{
    if(!directOkxMode())void loadCollectionConfig().then(s=>{if(s.configured&&!s.permissions)void refreshCollectionPermissions().catch(()=>{})})
    const timer=setInterval(()=>tick(n=>n+1),5000)
    return()=>clearInterval(timer)
  },[status.configured])
  const grants=status.permissions?.active_packages.filter(g=>g.markets.includes('crypto'))??[]
  const allowed=(op:string)=>grants.some(g=>g.capabilities.includes(op))
  const fresh=!!status.lastMarketAt&&Date.now()-status.lastMarketAt<30000
  return <div className="flex flex-wrap items-center gap-2 text-xs px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
    <span className={`h-2 w-2 rounded-full ${fresh?'bg-[var(--accent-up)]':'bg-[var(--text-muted)]'}`}/>
    <span className="font-medium">{directOkxMode()?'OKX 直连':'API VALUE COLLECTION'}</span>
    <span className="text-[var(--text-muted)]">{directOkxMode()?(fresh?'实时行情已接收':'正在连接 OKX'):!status.configured?'待配置 Key':fresh?'实时行情已接收':'已配置 · 等待行情'}</span>
    {cache.running&&<span className="text-[var(--text-muted)]">启动缓存 {cache.done}/{cache.total} · 后台补充历史</span>}
    {!cache.running&&cache.failed>0&&<span className="text-amber-400">部分历史缓存待补充（{cache.failed}）</span>}
    {account&&<span className="text-[var(--text-muted)]">{directOkxMode()?'账户与私有推送：本机签名直连 OKX':`账户接口：${allowed('okx_private')?'已授权':'未授权'} · 私有推送：${allowed('okx_private_ws')?'已授权':'未授权'}`}</span>}
    <a href="/profile?tab=data" className="ml-auto text-[var(--primary)]">数据配置</a>
  </div>
}
