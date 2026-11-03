import {useEffect,useState,useSyncExternalStore} from 'react'
import {hostSession,onHostSessionChange,type CenterAccount} from '@/lib/taskhost-client'
import {standaloneAccounts} from '@/lib/taskhost-standalone'
import {ManagedPanel} from '@/components/task-hosting/managed-panel'
export function HostedTaskList(){
 const session=useSyncExternalStore(onHostSessionChange,hostSession,hostSession)
 const [accounts,setAccounts]=useState<CenterAccount[]>([]),[error,setError]=useState('')
 useEffect(()=>{let disposed=false;setAccounts([]);setError('');if(session?.mode==='standalone')void standaloneAccounts().then(out=>{if(!disposed&&hostSession()===session)setAccounts(out.accounts)}).catch(()=>{if(!disposed)setError('中心托管任务暂不可读，可先在个人设置中配置 API Collection Key，再进入单机模式核对。')});return()=>{disposed=true}},[session])
 return <>{error&&<p className="my-3 text-sm text-amber-400">{error}</p>}<ManagedPanel credentials={[]} accounts={accounts} showSettings={false}/></>
}
