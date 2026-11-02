import {useEffect,useState} from 'react';
import {hostRequest,hostSession,type HostCredential,type CenterAccount} from '@/lib/taskhost-client';
import {managedCapabilities,createManagedTask,controlExistingTask,reconcileManagedTask,registerManagedTask,prepareManagedTask,standaloneControlAvailable,pendingManagedRequest,clearPendingManagedRequest,ManagedCreateUncertain,type ManagedTask,type ModelInfo,type ControlAction,type NativeTaskInput} from '@/lib/taskhost-managed';
import {GoWorkerPanel} from './worker-panel';
import {NativeTaskForm} from './task-form';
import {MigrationPanel} from './migration-panel';
import {prepareLocalWorker} from '@/lib/taskhost-worker';

const field='w-full mt-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2';
const button='rounded border border-[var(--border)] px-3 py-2 disabled:opacity-40';
export function ManagedPanel({credentials,accounts}:{credentials:HostCredential[];accounts:CenterAccount[]}) {
  const session=hostSession();
  const [tasks,setTasks]=useState<ManagedTask[]>([]),[models,setModels]=useState<ModelInfo[]>([]);
  const [available,setAvailable]=useState(false),[tradingEnabled,setTradingEnabled]=useState(false),[controls,setControls]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [requestID,setRequestID]=useState<string>(()=>crypto.randomUUID());
  const [unknown,setUnknown]=useState(false);
  async function refresh(){
    if(session?.mode==='standalone'){const supported=await standaloneControlAvailable();if(hostSession()===session)setControls(supported);return;}
    if(session?.mode!=='server')return;
    const caps=await managedCapabilities();
    const [t,m]=await Promise.all([hostRequest<{tasks:ManagedTask[];execution_authority:false}>('/api/v1/managed-tasks'),hostRequest<{models:ModelInfo[]}>('/api/v1/models')]);
    if(hostSession()!==session)return;
    if(t.execution_authority!==false || !Array.isArray(t.tasks) || !Array.isArray(m.models))throw new Error('Go 任务列表响应无效');
    setTasks(t.tasks);setModels(m.models);setAvailable(caps.runtime_available===true&&caps.managed_tasks===true);setTradingEnabled(caps.trading_enabled===true);setControls(true);
  }
  async function run(action:()=>Promise<void>){setBusy(true);setMessage('');try{await action();}catch{if(hostSession()===session)setMessage('请求未确认，请刷新核对。新建和交易动作不会自动重试。');}finally{if(hostSession()===session)setBusy(false);}}
  useEffect(()=>{setTasks([]);setModels([]);setAvailable(false);setControls(false);const pending=pendingManagedRequest();setUnknown(!!pending);setRequestID(pending||crypto.randomUUID());void run(refresh);},[session]);
  async function control(account:string,qualified:string,action:ControlAction,id?:string){
    try{const state=await controlExistingTask(account,qualified,action,id);if(hostSession()===session)setMessage(`中心最新状态：${state.deleted?'已删除':state.desired_state}。执行权仍由中心租约和核对决定。`);}
    catch(e){if(hostSession()===session)setMessage(e instanceof Error?e.message:'请刷新核对操作结果');}
    await refresh();
  }
  function actions(account:string,qualified:string,id?:string){return <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={()=>void run(async()=>{if(id)await prepareManagedTask(id,'delete');else await prepareLocalWorker(account,'prepare-delete');await refresh();setMessage('已完成删除准备。请核对中心状态，再单独点击删除；不会自动删除。');})}>准备删除</button><button className={button} disabled={busy} onClick={()=>void run(async()=>{if(id)await prepareManagedTask(id,'resume');else await prepareLocalWorker(account,'prepare-resume');await refresh();setMessage('执行器正在重新准备。请稍后刷新，再单独恢复任务。');})}>准备执行器</button>{(['pause','stop','resume','delete'] as ControlAction[]).map(action=><button key={action} type="button" className={button} disabled={busy||!controls} onClick={()=>void run(()=>control(account,qualified,action,id))}>{({pause:'暂停',stop:'停止',resume:'恢复',delete:'删除'})[action]}</button>)}</div>;}
  async function create(input:NativeTaskInput):Promise<boolean>{
    let accepted=false;
    await run(async()=>{
      try{const task=await createManagedTask(input);if(hostSession()!==session)return;accepted=true;setRequestID(crypto.randomUUID());setMessage(`服务器任务 ${task.id} 已创建，注册状态：${task.registration}。请核对实际执行状态。`);}
      catch(e){if(hostSession()!==session)return;setUnknown(e instanceof ManagedCreateUncertain);setMessage(e instanceof Error?e.message:'新建结果未确认');}
      await refresh();
    });
    return accepted;
  }
  return <section className="mb-8 rounded border border-[var(--border)] p-5">
    <div className="flex flex-wrap justify-between gap-3"><h2 className="text-lg font-semibold">Go 原生任务</h2><button className={button} disabled={busy} onClick={()=>void run(refresh)}>刷新任务与能力</button></div>
    <p className="my-3 text-sm text-[var(--text-muted)]">{session?.mode==='standalone'?'单机模式读取中心已有任务，可操作和删除，不能新建任务。恢复仅适用于原服务器签发恢复策略的 Go 任务。':available?'服务器已开放 Go 任务创建；注册、恢复和交易仍需通过中心的租约及风险核对。':'服务器尚未开放 Go 运行时，暂不能新建任务。'}</p>
    {message&&<p role="status" className="my-3 rounded border border-amber-500/30 p-3 text-sm break-all">{message}</p>}
    {session?.mode==='server'&&available&&!tradingEnabled&&<p className="my-3 rounded border border-amber-500/30 p-3 text-sm">服务器当前为观察模式。可以创建和同步任务；交易执行需要管理员在服务器明确启用。</p>}
    {session?.mode==='standalone'? accounts.map(account=><div key={account.account_id} className="my-4 border-t border-[var(--border)] pt-3">
      {account.tasks.map(task=><div key={task.authority+':'+task.task_id} className="my-3 flex flex-wrap justify-between gap-3"><div>{task.config?.go_task?.spec?.name||task.config?.task?.name||task.task_id}<p className="text-xs text-[var(--text-muted)]">{task.desired_state}</p>{task.config?.go_task?.spec?.model_id&&<p className="mt-1 break-all text-xs text-[var(--text-muted)]">模型记录 {task.config.go_task.spec.model_id}</p>}</div>{actions(account.account_id,task.authority+':'+task.task_id)}</div>)}
      <GoWorkerPanel accountID={account.account_id}/>
    </div>):<>
      {session?.mode==='server'&&session.centerScope&&accounts.map(account=><GoWorkerPanel key={account.account_id} accountID={account.account_id}/>)}
      {tasks.map(task=><div key={task.id} className="my-4 border-t border-[var(--border)] py-3"><div className="flex flex-wrap justify-between gap-3"><div><strong>{task.name}</strong> · {task.kind} · {task.symbol}<p className="text-sm mt-1">{task.center_desired_state||task.desired_state} · 注册 {task.registration} · 版本 {task.revision} / {task.control_version}</p><p className="text-xs mt-1 text-[var(--text-muted)] break-all">{task.id} · 运行观察 {task.status}</p>{task.model_id&&<p className="mt-1 break-all text-xs text-[var(--text-muted)]">模型记录 {task.model_id}</p>}</div>{task.registration==='acknowledged'?actions(task.account_id,'',task.id):task.registration==='prepared'?<button className={button} disabled={busy} onClick={()=>void run(async()=>{await registerManagedTask(task.id);await refresh();setMessage('已提交未发送过的注册请求，请核对中心结果。');})}>注册到中心</button>:<button className={button} disabled={busy} onClick={()=>void run(async()=>{await reconcileManagedTask(task.id);await refresh();setMessage('已读取中心并核对注册结果，未重复注册或发送交易动作。');})}>核对注册结果</button>}</div></div>)}
      {unknown&&<div className="my-4"><p className="text-amber-500 text-sm">本次创建结果未知，已锁定该请求。只允许查询原请求结果。</p><button className={button} disabled={busy} onClick={()=>void run(async()=>{const out=await hostRequest<{task:ManagedTask;execution_authority:false}>('/api/v1/managed-task-requests/'+requestID);if(hostSession()!==session)return;if(out.execution_authority!==false||!out.task?.id)throw new Error();clearPendingManagedRequest();setUnknown(false);setRequestID(crypto.randomUUID());await refresh();setMessage('已找到服务器生成的任务，请核对列表中的注册和执行状态。');})}>查询原创建结果</button></div>}
      <NativeTaskForm key={'create:'+(session?.mode==="server"?session.origin+session.ownerID:"standalone")} requestID={requestID} models={models} credentials={credentials} disabled={busy||!available||unknown} onCreate={create} onError={setMessage}/>
      <MigrationPanel key={'migrate:'+(session?.mode==='server'?session.origin+session.ownerID:'standalone')} accounts={accounts} credentials={credentials} models={models} onChanged={refresh}/>
      <form className="grid md:grid-cols-2 gap-4 mt-8" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const input=Object.fromEntries(new FormData(form));void run(async()=>{try{await hostRequest('/api/v1/models',{method:'POST',body:JSON.stringify(input)});form.reset();await refresh();setMessage('模型配置已在服务器加密保存。');}finally{const secret=form.elements.namedItem('api_key') as HTMLInputElement;secret.value='';}});}}>
        <h3 className="font-semibold md:col-span-2">加密保存 AI 模型</h3><label>名称<input name="name" className={field} required maxLength={120}/></label><label>接口类型<select name="kind" className={field}><option value="openai">OpenAI 兼容</option><option value="claude">Claude</option><option value="jev">Jev</option></select></label><label>HTTPS 基础地址<input name="base_url" type="url" className={field} required placeholder="https://api.example.com/v1"/></label><label>模型 ID<input name="model_id" className={field} required/></label><label className="md:col-span-2">API Key<input name="api_key" className={field} type="password" autoComplete="off" required/></label><button className={button+' md:col-span-2'} disabled={busy}>加密保存到服务器</button>
      </form>
    </>}
  </section>;
}
