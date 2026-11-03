import { invoke, isTauri } from "@tauri-apps/api/core";
import {collectionScope,loadCollectionConfig} from './collection-config';
import {
  enterStandalone,
  hostSession,
  beginHostLoginAttempt,hostLoginAttempt,
	attachOnlineCenter,
	type HostSession,
  type CenterAccount,
} from "./taskhost-client";

/** Save the same verified center identity for an explicit online standby process. */
export async function saveOnlineStandbyKey(key:string,user:string,expected:HostSession){
  if(!isTauri()||expected.mode!=='server'||hostSession()!==expected)throw new Error('请在桌面服务器连接中配置备用执行器');
  const checked=await invoke<{permissions?:{user_id?:string}}>('collection_key',{scope:'taskhost:login-probe',action:'test',key});
  if(hostSession()!==expected||checked.permissions?.user_id!==user)throw new Error('本机与服务器的中心账户不一致');
  const scope=`taskhost:standalone:${user}`;
  await invoke('collection_key',{scope,action:'save',key});
  if(hostSession()!==expected)throw new Error('会话已变化');
  attachOnlineCenter(expected,scope,user);
}

/** This flow contacts the center directly; no business-server credentials are used. */
export async function loginStandalone(key: string) {
  key=key.trim();
  const original=hostSession(),originalScope=collectionScope(),attempt=beginHostLoginAttempt();
  if(!key){
    const scope=originalScope;
    enterStandalone({scope,centerUserID:'',centerVerified:false});
    const local=hostSession();
    // Local entry never waits for a center/network probe. Only a current,
    // independently verified response may later attach existing center tasks.
    if(isTauri()&&!scope.endsWith(':anonymous'))void(async()=>{try{
      const current=()=>hostSession()===local&&collectionScope()===scope&&hostLoginAttempt()===attempt;
      const config=await loadCollectionConfig();if(!current()||!config.configured)return;
      const reply=await invoke<{configured:boolean;scope:string;user_id:string}>('collection_key',{scope,action:'standalone',key:null});
      if(current()&&reply.configured===true&&typeof reply.user_id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(reply.user_id)&&reply.scope===`taskhost:standalone:${reply.user_id}`)enterStandalone({scope:reply.scope,centerUserID:reply.user_id,centerVerified:true});
    }catch{/* Offline workspace stays available; no center authority is inferred. */}})();
    return;
  }
  if (!isTauri())
    throw new Error("单机 Key 使用原生安全存储，请在桌面应用中使用");
  if (!/^ac_[A-Za-z0-9_-]{17,157}$/.test(key))
    throw new Error("请输入有效的 API VALUE COLLECTION Key");
  const checked = await invoke<{ permissions?: { user_id?: string } }>(
    "collection_key",
    { scope: "taskhost:login-probe", action: "test", key },
  );
  const user = checked.permissions?.user_id;
  if (!user||!/^[A-Za-z0-9_-]{1,100}$/.test(user)) throw new Error("接口中心未确认用户身份");
  if(hostSession()!==original||collectionScope()!==originalScope||hostLoginAttempt()!==attempt)throw new Error('当前连接或本地配置已变化，请重新登录');
  const scope = `taskhost:standalone:${user}`;
  await invoke("collection_key", { scope, action: "save", key });
  if(hostSession()!==original||collectionScope()!==originalScope||hostLoginAttempt()!==attempt)throw new Error('当前连接或本地配置已变化，请重新登录');
  enterStandalone({ scope, centerUserID: user,centerVerified:true });
}
export async function standaloneAccounts(): Promise<{
  accounts: CenterAccount[];
}> {
  const session = hostSession();
  if (session?.mode !== "standalone") throw new Error("请先完成单机登录");
  if(session.centerVerified===false)throw new Error('尚未连接接口中心。可在个人设置中填写 API Collection Key，随后重新进入单机模式读取已有托管任务');
  const reply = await invoke<{
    code: number;
    data: CenterAccount[];
    msg?: string;
  }>("collection_http", {
    scope: session.scope,
    path: "/v1/execution/accounts",
    body: null,
  });
  if (hostSession() !== session) throw new Error("会话已变化");
  if (reply.code !== 200 || !Array.isArray(reply.data))
    throw new Error(reply.msg || "接口中心托管任务读取失败");
  return { accounts: reply.data };
}
/** Stop is the existing center account-wide control, never represented as a single-task stop. */
export async function stopStandaloneAccount(account: CenterAccount) {
  const session = hostSession();
  if (session?.mode !== "standalone") throw new Error("请先完成单机登录");
  if(session.centerVerified===false)throw new Error('请先配置并验证 API Collection Key');
  const reply = await invoke<{ code: number; data: unknown; msg?: string }>(
    "collection_http",
    {
      scope: session.scope,
      path: "/v1/execution/stop-account",
      body: { account_id: account.account_id, expected_epoch: account.epoch },
    },
  );
  if (hostSession() !== session)
    throw new Error("会话已变化，请在原中心账户核对停止结果");
  if (reply.code !== 200)
    throw new Error(reply.msg || "中心未确认账户停止结果");
  return reply.data;
}
