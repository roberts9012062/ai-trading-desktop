import {useState} from 'react'
import {invoke,isTauri} from '@tauri-apps/api/core'
import {useNavigate} from 'react-router-dom'
import * as Menu from '@radix-ui/react-dropdown-menu'
import {ChevronDown,LogOut,Settings,Server} from 'lucide-react'
import {hostSession,logoutHost} from '@/lib/taskhost-client'
import {useAuthStore} from '@/stores/auth'

/** A desktop key does not impersonate an old administrator or JWT account. */
export function HostUserMenu(){
  const user=useAuthStore(state=>state.user),session=hostSession(),navigate=useNavigate()
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  async function disconnect(){
    setBusy(true);setError('')
    try{
      if(isTauri())await invoke('taskhost_go_shutdown')
      logoutHost();navigate('/login',{replace:true})
    }catch{setError('本机执行器尚未确认退出，连接已保留。请先在任务托管页核对停止状态。')}
    finally{setBusy(false)}
  }
  const row='flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer outline-none data-[highlighted]:bg-[var(--bg-tertiary)]'
  return <>
    <Menu.Root><Menu.Trigger asChild><button aria-label="用户菜单" disabled={busy} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--bg-tertiary)]"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary)] text-xs text-white">{user?.username.slice(0,1)||'G'}</span><span className="hidden text-sm sm:inline">{user?.username||'本地配置'}</span><ChevronDown className="h-3 w-3"/></button></Menu.Trigger><Menu.Portal><Menu.Content align="end" sideOffset={8} className="z-50 min-w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5 shadow-xl">
      <Menu.Label className="max-w-xs break-all px-3 py-2 text-xs text-[var(--text-muted)]">{session?.mode==='server'?session.origin:'API Collection 单机会话'}</Menu.Label>
      <Menu.Item className={row} onSelect={()=>navigate('/profile')}><Settings className="h-4 w-4"/>个人与本地配置</Menu.Item>
      <Menu.Item className={row} onSelect={()=>navigate('/task-hosting')}><Server className="h-4 w-4"/>任务托管与连接状态</Menu.Item>
      <Menu.Separator className="my-1 h-px bg-[var(--border)]"/>
      <Menu.Item className={row} disabled={busy} onSelect={()=>void disconnect()}><LogOut className="h-4 w-4"/>{busy?'正在确认退出…':'断开连接 / 切换服务器'}</Menu.Item>
    </Menu.Content></Menu.Portal></Menu.Root>
    {error&&<p role="alert" className="absolute right-4 top-14 z-50 max-w-sm rounded border border-amber-500/30 bg-[var(--bg-secondary)] p-3 text-xs text-amber-400">{error}</p>}
  </>
}
