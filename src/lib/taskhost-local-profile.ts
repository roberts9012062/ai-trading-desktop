import {collectionScope} from './collection-config'

export interface LocalHostProfile {scope:string;label:string}
/** Only the selected real-account profile is eligible; saved account lists and
 * anonymous stores are never searched for credentials. A fresh Go handshake
 * explicitly pins this local selection to its server owner. */
export function selectedLocalHostProfile():LocalHostProfile|null {
  try {
    const user=JSON.parse(localStorage.getItem('qihuo_auth_user')||'null') as {id?:unknown;username?:unknown;trading_mode?:unknown}|null
    if(typeof user?.id!=='string'||!user.id||user.id.length>100||/[\u0000-\u001f\u007f]/.test(user.id)||user.trading_mode!=='live')return null
    const scope=collectionScope()
    if(scope.length>512||!scope.endsWith(`:${user.id}`)||scope.endsWith(':anonymous'))return null
    return {scope,label:typeof user.username==='string'&&user.username.length<=100?user.username:'当前本地实盘配置'}
  }catch{return null}
}
