import type {User} from '@/types'
import {useAuthStore} from '@/stores/auth'
import {hostSession,attachHostLocalProfile,type HostSession} from './taskhost-client'
import {selectedLocalHostProfile} from './taskhost-local-profile'

/** Local display/storage identity only. Never a legacy JWT or a server permission. */
export async function activateHostWorkspace(session:HostSession):Promise<void>{
  const raw=localStorage.getItem('qihuo_auth_user')
  let user:User|null=null
  if(raw){
    try{user=JSON.parse(raw) as User}catch{throw new Error('当前本地配置格式异常，原数据已保留，请检查本地配置')}
    if(!user||typeof user.id!=='string'||!user.id||typeof user.username!=='string'||!user.username)throw new Error('当前本地配置无效，原数据已保留')
  }
  if(session.mode==='server'&&session.localProfileScope&&selectedLocalHostProfile()?.scope!==session.localProfileScope)throw new Error('当前本地配置已变化，请重新连接服务器')
  if(!user){
    const binding=session.mode==='server'?['server',session.origin,session.ownerID]:['standalone',session.centerUserID]
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(binding)))
    const id='taskhost:'+Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')
    user={id,username:session.mode==='server'?'Go 本地配置':'单机本地配置',phone:null,email:null,avatar:null,role:'user',status:'active',trading_mode:'live'}
    if(hostSession()!==session||localStorage.getItem('qihuo_auth_user')!==null)throw new Error('连接或本地配置已变化，请重新登录')
    localStorage.setItem('qihuo_auth_user',JSON.stringify(user))
  }
  if(hostSession()!==session)throw new Error('服务器连接已变化，请重新登录')
  // Keep original profile IDs, tokens, settings and DPAPI scopes. The Go bearer
  // stays solely in its own session and is never installed as access_token.
  useAuthStore.setState({user,loaded:true,hydrating:false})
  if(session.mode==='server'&&!session.localProfileScope){
    const profile=selectedLocalHostProfile()
    if(profile)attachHostLocalProfile(session,profile.scope,profile.label)
  }
}
