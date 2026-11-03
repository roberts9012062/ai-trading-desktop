import {useEffect,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {hostSession} from '@/lib/taskhost-client';
import {prepareLocalWorker,parseLocalGoWorkerStatus,localGoDataNotice,type LocalGoWorkerStatus} from '@/lib/taskhost-worker';
const button='rounded border border-[var(--border)] px-3 py-2 disabled:opacity-40';
const field='mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2';
type Status=LocalGoWorkerStatus;
export function localWorkerInput(d:Record<string,FormDataEntryValue>,count:number){
  const models=Array.from({length:count},(_,i)=>{const suffix=String(i);return d['model_record_id_'+suffix]?{id:String(d['model_record_id_'+suffix]),name:String(d['model_name_'+suffix]||'本机模型'),kind:String(d['model_kind_'+suffix]),base_url:String(d['base_url_'+suffix]),model_id:String(d['model_id_'+suffix]),api_key:String(d['model_key_'+suffix])}:null;}).filter(model=>model!==null);
  return {exchange:{api_key:String(d.api_key),secret:String(d.secret),passphrase:String(d.passphrase),demo:d.demo==='on'},models};
}
export function GoWorkerPanel({accountID}:{accountID:string}){
  const session=hostSession();const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[allowTrading,setAllowTrading]=useState(false),[flatConfirmed,setFlatConfirmed]=useState(false),[modelCount,setModelCount]=useState(1);
  async function request(action:string,input?:unknown){
    const scope=session?.mode==='standalone'?session.scope:session?.centerScope;
    if(!isTauri()||!scope)throw new Error('请先在桌面绑定中心 Key，配置本机备用执行器');
    const result=await invoke<Status>('taskhost_go_worker',{scope,accountId:accountID,action,input:input??null,allowTrading,expectedGeneration:status?.generation??null});
    if(hostSession()!==session)throw new Error('会话已变化');return action==='status'?parseLocalGoWorkerStatus(result,accountID):result;
  }
  async function refresh(){const result=await request('status');if(result.execution_authority!==false)throw new Error('执行器状态无效');setStatus(result);}
  async function run(fn:()=>Promise<void>){setBusy(true);setMessage('');try{await fn();}catch{if(hostSession()===session)setMessage('执行器请求未确认，请刷新并核对中心租约和检查点。不会自动重启。');}finally{if(hostSession()===session)setBusy(false);}}
  useEffect(()=>{setStatus(null);setAllowTrading(false);setFlatConfirmed(false);setModelCount(1);void run(refresh);const timer=setInterval(()=>{if(hostSession()===session)void refresh().catch(()=>{});},5000);return()=>clearInterval(timer);},[session,accountID]);
  return <>
    {localGoDataNotice(status?.status)&&<div role="alert" className="my-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400"><p>{localGoDataNotice(status?.status)}</p><p className="mt-1">{status?.status?.data_stale?'本机尚未取得新鲜账户确认，旧持仓不能视为当前状态。':'数据读取状态不授予执行权，也不代表退出已确认。'}</p><a className="mt-2 inline-block underline" href="https://lium.eu.org/" target="_blank" rel="noreferrer">配置 / 获取 API Collection Key</a>{session?.mode==='server'&&<a className="ml-3 mt-2 inline-block underline" href="/task-hosting#client-data-sync">同步当前本地 Key</a>}</div>}
  <details className="mt-4 border border-[var(--border)] rounded p-3"><summary>本机 Go 执行器 · 此中心账户</summary>
    <p className="text-xs my-3 text-[var(--text-muted)]">仅读取中心已经存在、具有原服务器签名和完整 Go 检查点的 AI / 短线任务。旧任务不会自动转成 Go 任务。启动成功仅代表进程启动，执行权由中心核对和租约独立决定。</p>
    <p className="text-xs my-3 text-[var(--text-muted)]">请在服务器正常在线时配置并启动本机备用进程，保持客户端运行。故障后才首次启动的新进程可能需要空仓恢复；中心不会把新进程当作一直在线的备用端。</p>
    <p className="text-sm">{status?.installed?'已安装固定版本 Go 执行器':'此版本未包含已验证 Go 执行器'} · {status?.status?.state||'未启动'}{status?.active_elsewhere?' · 其他账户执行器尚未退出':''}</p>
    {status?.status?.error_code&&<p className="text-sm text-amber-500">执行器状态：{status.status.error_code}</p>}
    {message&&<p role="status" className="text-sm text-amber-500 my-2">{message}</p>}
    <form className="grid gap-3 md:grid-cols-2 mt-4" onSubmit={e=>{e.preventDefault();const form=e.currentTarget,d=Object.fromEntries(new FormData(form));void run(async()=>{
      try{await request('save',localWorkerInput(d,modelCount));form.reset();setModelCount(1);await refresh();setMessage('凭证已使用当前 Windows 用户的 DPAPI 加密保存，不写入命令行。');}
      finally{for(const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]'))input.value='';}
    });}}>
      {['api_key','secret','passphrase'].map(name=><label key={name}>{({api_key:'OKX API Key',secret:'OKX Secret',passphrase:'OKX Passphrase'})[name]}<input className={field} name={name} type="password" autoComplete="off" required maxLength={256}/></label>)}
      <label className="flex items-center gap-2"><input name="demo" type="checkbox" defaultChecked/>模拟盘凭证</label>
      <p className="text-xs md:col-span-2 text-[var(--text-muted)]">同一账户有多个模型时，请按任务列表显示的模型记录逐一配置。短线任务无需模型；缺失模型的任务会停止在核对状态。</p>
      {Array.from({length:modelCount},(_,i)=><fieldset key={i} className="grid md:col-span-2 md:grid-cols-2 gap-3 rounded border border-[var(--border)] p-3"><legend className="px-1 text-sm">可选本机模型 {i+1}</legend><label>任务中的模型记录 ID<input className={field} name={'model_record_id_'+i} placeholder="服务器模型 UUID"/></label><label>模型名称<input className={field} name={'model_name_'+i}/></label><label>模型接口<select className={field} name={'model_kind_'+i}><option value="openai">OpenAI 兼容</option><option value="claude">Claude</option><option value="jev">Jev</option></select></label><label>模型 HTTPS 地址<input className={field} type="url" name={'base_url_'+i}/></label><label>模型 ID<input className={field} name={'model_id_'+i}/></label><label>模型 API Key<input className={field} name={'model_key_'+i} type="password" autoComplete="off"/></label></fieldset>)}
      <div className="md:col-span-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy||modelCount>=50} onClick={()=>setModelCount(count=>count+1)}>添加一个模型</button>{modelCount>1&&<button type="button" className={button} disabled={busy} onClick={()=>setModelCount(count=>count-1)}>移除最后一个模型</button>}</div>
      <button className={button+' md:col-span-2'} disabled={busy||status?.exited===false||status?.active_elsewhere}>加密保存本机输入</button>
    </form>
    <label className="flex gap-2 my-4 text-sm"><input type="checkbox" checked={allowTrading} disabled={busy||status?.exited===false} onChange={e=>setAllowTrading(e.target.checked)}/>明确允许本机申请执行既有任务（默认只观察，仍受中心隔离与核对约束）</label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy||!status?.installed||!status.configured||status.active||status.exited===false||status.active_elsewhere} onClick={()=>void run(async()=>{await request('start');await refresh();setMessage('Go 进程已启动，正在读取中心状态；尚不能据此确认已接管。');})}>{allowTrading?'启动备用并允许故障接管':'启动只读观察'}</button><button className={button} disabled={busy||!status?.active} onClick={()=>void run(async()=>{await request('stop');await refresh();setMessage('进程已退出并收到停止回执；请核对中心最新状态。');})}>停止并等待退出确认</button><button className={button} disabled={busy} onClick={()=>void run(refresh)}>刷新进程状态</button></div>
    <div className="mt-4 border-t border-[var(--border)] pt-3 text-sm"><p>若中心要求故障恢复，请先自行核对账户已全平、全部挂单已清理。确认只解除恢复锁，任务保持停止。</p><label className="my-3 flex gap-2"><input type="checkbox" checked={flatConfirmed} disabled={busy} onChange={e=>setFlatConfirmed(e.target.checked)}/>我已核对该账户全平且没有挂单</label><button className={button} disabled={busy||!flatConfirmed||!status?.active||status.active_elsewhere} onClick={()=>void run(async()=>{await prepareLocalWorker(accountID,'confirm-flat');if(hostSession()!==session)return;setFlatConfirmed(false);await refresh();setMessage('中心已确认空仓恢复，任务仍保持停止。请刷新中心任务，再单独准备执行器和恢复任务。');})}>读取全部状态并确认空仓恢复</button></div>
  </details></>;
}
