"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, LogOut, Shield, UserPlus, X } from "lucide-react"
import { useAuthStore } from "@/stores/auth"
import { accountServer, forgetAccount, loadAccounts, MAX_ACCOUNTS, rememberAccount, type AccountSession } from "@/lib/account-profiles"
import { signInAccount } from "@/lib/account-sessions"
import { switchAccount } from "@/lib/account-switch"
import { stopAllRealtime } from "@/lib/realtime-factor/runtime"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const itemClass="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none data-[highlighted]:bg-[var(--bg-tertiary)] data-[disabled]:opacity-40"
export function UserMenu(): React.JSX.Element {
  const router=useRouter()
  const { user,accessToken,logout }=useAuthStore()
  const [accounts,setAccounts]=useState<AccountSession[]>([])
  const [open,setOpen]=useState(false)
  const [username,setUsername]=useState("")
  const [password,setPassword]=useState("")
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState("")
  const [notice,setNotice]=useState("")
  useEffect(()=>{
    try {
      if(user&&accessToken)setAccounts(rememberAccount({user,accessToken,refreshToken:localStorage.getItem("refresh_token")??""}))
      else setAccounts(loadAccounts())
    }catch(e){setError(e instanceof Error?e.message:"账号列表读取失败")}
  },[user,accessToken])
  function addDialog(name="") {setUsername(name);setPassword("");setError("");setNotice("");setOpen(true)}
  async function add(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError("")
    const server=accountServer(),owner=user?.id
    try {
      const session=await signInAccount(username.trim(),password)
      if(server!==accountServer()||owner!==useAuthStore.getState().user?.id)throw new Error("当前会话已变化，请重试")
      setAccounts(rememberAccount(session));setPassword("");setOpen(false);setNotice(`已添加 ${session.user.username}，可在菜单中切换`)
    }catch(e){setError(e instanceof Error?e.message:"添加失败")}
    finally{setBusy(false)}
  }
  async function select(session:AccountSession) {
    if(session.user.id===user?.id||busy)return
    setBusy(true);setError("");setNotice("")
    try {await switchAccount(session)}
    catch(e){
      const expired=(e as {status?:number}).status===401
      if(expired){addDialog(session.user.username);setError("该账号登录已过期，请重新输入密码")}
      else setError(e instanceof Error?e.message:"切换失败")
    }finally{setBusy(false)}
  }
  async function signOut() {
    setBusy(true)
    await stopAllRealtime("已退出登录，恢复普通模式")
    logout();window.location.replace("/login")
  }
  return <>
    <Menu.Root onOpenChange={value=>{if(value)setAccounts(loadAccounts())}}><Menu.Trigger asChild><button aria-label="用户菜单" disabled={busy} className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[var(--bg-tertiary)] outline-none disabled:opacity-50"><span className="w-7 h-7 rounded-full bg-[var(--primary)] flex items-center justify-center text-white text-xs">{user?.username.charAt(0).toUpperCase()??"?"}</span><span className="text-sm hidden sm:inline">{busy?"处理中…":user?.username??"加载中…"}</span><ChevronDown className="w-3 h-3" /></button></Menu.Trigger>
      <Menu.Portal><Menu.Content align="end" sideOffset={8} className="min-w-[240px] max-w-xs rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5 shadow-xl z-50">
        <Menu.Label className="px-3 py-2 text-xs text-[var(--text-muted)]">已添加用户 {accounts.length}/{MAX_ACCOUNTS}</Menu.Label>
        {accounts.map(session=><div key={session.user.id} className="flex items-center"><Menu.Item className={`${itemClass} flex-1 min-w-0`} disabled={busy} onSelect={()=>void select(session)}><span className="truncate">{session.user.username}</span><span className="text-[10px] text-[var(--text-muted)]">{session.user.trading_mode==="virtual"?"虚拟盘":"实盘"}</span>{session.user.id===user?.id&&<Check className="w-4 h-4 ml-auto text-emerald-400" />}</Menu.Item>{session.user.id!==user?.id&&<button aria-label={`移除用户 ${session.user.username}`} title="仅从本机列表移除" disabled={busy} className="p-2 text-[var(--text-muted)] hover:text-red-400" onClick={()=>{setAccounts(forgetAccount(session.user.id));setError("")}}><X className="w-3 h-3" /></button>}</div>)}
        <Menu.Separator className="h-px bg-[var(--border)] my-1" />
        <Menu.Item disabled={busy||accounts.length>=MAX_ACCOUNTS} className={itemClass} onSelect={()=>addDialog()}><UserPlus className="w-4 h-4" />添加用户{accounts.length>=MAX_ACCOUNTS&&<span className="text-xs">（已满）</span>}</Menu.Item>
        {user?.role==="admin"&&<Menu.Item className={itemClass} disabled={busy} onSelect={()=>router.push("/admin/dashboard")}><Shield className="w-4 h-4" />管理后台</Menu.Item>}
        <Menu.Item className={`${itemClass} text-red-400`} disabled={busy} onSelect={()=>void signOut()}><LogOut className="w-4 h-4" />退出当前账号</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
    {(error&&!open||notice)&&<div role="status" className="absolute top-14 right-4 z-40 max-w-sm rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs shadow-lg"><span className={error?"text-red-400":"text-emerald-400"}>{error||notice}</span><button aria-label="关闭账号提示" className="ml-3" onClick={()=>{setError("");setNotice("")}}>×</button></div>}
    <Dialog open={open} onOpenChange={value=>{if(!busy){setOpen(value);setPassword("");setError("")}}}><DialogContent><DialogHeader><DialogTitle>添加用户</DialogTitle><DialogDescription>含当前账号最多添加 5 个用户。验证成功后可从右上角菜单切换。</DialogDescription></DialogHeader><form onSubmit={e=>void add(e)} className="space-y-4"><label className="block text-sm space-y-2"><span>用户名</span><Input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" disabled={busy} required /></label><label className="block text-sm space-y-2"><span>密码</span><Input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" disabled={busy} required /></label>{error&&<p role="alert" className="text-sm text-red-400">{error}</p>}<Button className="w-full" type="submit" disabled={busy}>{busy?"正在验证…":"添加用户"}</Button></form></DialogContent></Dialog>
    {busy&&<div className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center" role="status"><p className="rounded-lg bg-[var(--bg-secondary)] p-4 text-sm">正在验证账号或切换会话…</p></div>}
  </>
}
