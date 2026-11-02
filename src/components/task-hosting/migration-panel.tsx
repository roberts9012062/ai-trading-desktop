import {useEffect,useState} from 'react';
import {hostSession,type CenterAccount,type HostCredential} from '@/lib/taskhost-client';
import type {ModelInfo} from '@/lib/taskhost-managed';
import {inspectMigration,witnessMigration,pauseLegacyForMigration,stopLegacyForMigration,commitMigration,pendingMigration,resolveMigration,MigrationUncertain,type MigrationReview,type MigrationSelection} from '@/lib/taskhost-migration';

const field='mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2';
const button='rounded border border-[var(--border)] px-3 py-2 disabled:opacity-40';
const issues:Record<string,string>={source_execution_not_fenced:'原执行器仍持有账户，请完成真实交接',source_task_not_paused:'原任务尚未暂停',source_unresolved_commands:'中心仍有交易结果待核对',source_manual_recovery_required:'中心要求手动恢复核验',source_continuity_pending:'等待原执行器见证新的服务器进程',runtime_state_requires_reconciliation:'原运行状态不完整，需要先核对订单',forecast_runtime_conversion_pending:'预测运行状态尚不能迁移',unsupported_total_pnl:'该任务使用尚未迁移的累计收益规则'};
export function MigrationPanel({accounts,credentials,models,onChanged}:{accounts:CenterAccount[];credentials:HostCredential[];models:ModelInfo[];onChanged:()=>Promise<void>}){
 const session=hostSession();
 const choices=accounts.flatMap(a=>a.tasks.filter(t=>t.config?.task&&['ai','decision','forecast','shortline'].includes(t.config.task.strategy_type||'')).map(t=>({account:a.account_id,task:t.authority+':'+t.task_id,name:t.config?.task?.name||t.task_id,kind:t.config?.task?.strategy_type})));
 const [selected,setSelected]=useState(''),[credential,setCredential]=useState(''),[model,setModel]=useState(''),[review,setReview]=useState<MigrationReview|null>(null),[witness,setWitness]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState<string|null>(()=>pendingMigration());
 const choice=choices.find(c=>c.task===selected);
 const selection:MigrationSelection={account_id:choice?.account||'',task_id:selected,credential_id:credential,model_id:choice?.kind==='shortline'?'':model};
 const valid=!!choice&&!!credential&&(choice.kind==='shortline'||!!model);
 useEffect(()=>{setReview(null);setWitness('');},[selected,credential,model]);
 async function run(action:()=>Promise<void>){setBusy(true);setMessage('');try{await action();}catch(error){if(hostSession()===session){setMessage(error instanceof Error?error.message:'交接尚未确认，请核对');if(error instanceof MigrationUncertain)setPending(pendingMigration());}}finally{if(hostSession()===session)setBusy(false);}}
 function current(){if(hostSession()!==session)throw new Error('会话已变化');}
 if(session?.mode!=='server')return null;
 return <details className="mt-8 rounded border border-[var(--border)] p-4"><summary className="cursor-pointer font-semibold">迁移中心已有的旧任务</summary>
  <p className="my-3 text-sm text-[var(--text-muted)]">先保持原执行器在线，建立服务器见证，再暂停并退出旧执行器。最后重新检查完整状态，按原 ID 迁移。原服务器签名私钥须由管理员提前导入；不支持的策略或不完整订单会阻止迁移。</p>
  <div className="grid gap-3 md:grid-cols-3"><label>中心原任务<select className={field} value={selected} onChange={e=>setSelected(e.target.value)} disabled={busy||!!pending}><option value="">请选择原任务</option>{choices.map(c=><option key={c.task} value={c.task}>{c.name} · {c.kind}</option>)}</select></label><label>本服务器交易凭证<select className={field} value={credential} onChange={e=>setCredential(e.target.value)} disabled={busy||!!pending}><option value="">请选择并先核验账户</option>{credentials.map(c=><option key={c.id} value={c.id}>{c.label||c.api_key_masked}</option>)}</select></label><label>本服务器模型<select className={field} value={model} onChange={e=>setModel(e.target.value)} disabled={busy||!!pending||choice?.kind==='shortline'}><option value="">{choice?.kind==='shortline'?'短线无需模型':'请选择原模型的对应配置'}</option>{models.map(m=><option key={m.id} value={m.id}>{m.name} · {m.kind}</option>)}</select></label></div>
  <div className="mt-4 flex flex-wrap gap-2">
   <button className={button} disabled={busy||!valid||!!pending} onClick={()=>void run(async()=>{const out=await inspectMigration(selection);current();setReview(out);setMessage(out.convertible?'原运行状态可转换。请核对检查点后再提交。':'请先解决下方阻止原因。');})}>检查原任务</button>
   <button className={button} disabled={busy||!valid||!!pending} onClick={()=>void run(async()=>{const out=await witnessMigration(selection);current();setWitness(out.state);setMessage(out.state==='observing'?'服务器见证已确认。现在可以暂停原任务并退出旧执行器。':'服务器正在建立见证，请保持原执行器在线，稍后再次检查。');})}>建立／检查服务器见证</button>
   <button className={button} disabled={busy||!valid||!!pending||witness!=='observing'} onClick={()=>void run(async()=>{await pauseLegacyForMigration(selection);current();setReview(null);setMessage('已提交原任务暂停。请确认原任务不再运行，然后退出旧执行器。');})}>暂停原任务</button>
   <button className={button} disabled={busy||!choice||!!pending||witness!=='observing'} onClick={()=>void run(async()=>{const out=await stopLegacyForMigration(selection.account_id);current();setReview(null);setMessage(out.shutdown_acknowledged?'本机旧执行器已实际退出并确认交接。请重新检查原任务，取得最新检查点。':'本机没有对应旧执行器。若任务由原服务器执行，请在原服务器完成退出，再重新检查。');})}>退出本机旧执行器</button>
   <button className={button} disabled={busy||!!pending||!review?.convertible||!review.center_ready||review.issues.length>0} onClick={()=>void run(async()=>{if(!review)return;const task=await commitMigration(selection,review,crypto.randomUUID());current();setReview(null);setPending(null);setMessage(`任务 ${task.id} 已按原身份保存，注册 ${task.registration}。迁移后保持暂停，请再核对执行器和风险状态。`);await onChanged();})}>按原 ID 提交迁移</button>
  </div>
  {review&&<div className="mt-3 text-sm"><p>原版本 {review.source_revision} · 控制版本 {review.source_control_version} · 检查点 {review.checkpoint_seq} · 栅栏 {review.epoch}</p>{!review.center_ready&&<p className="text-amber-500">中心协议尚未部署，不能提交迁移。</p>}{review.issues.map(code=><p className="mt-1 text-amber-500" key={code}>{issues[code]||`需要核对：${code}`}</p>)}</div>}
  {pending&&<div className="mt-3 text-sm"><p>迁移请求 {pending} 结果未确认，已锁定重复提交。</p><button className={button+' mt-2'} disabled={busy} onClick={()=>void run(async()=>{const task=await resolveMigration(pending);current();setPending(null);setMessage(`已找到原任务 ${task.id}，注册 ${task.registration}，请核对列表。`);await onChanged();})}>查询原迁移结果</button></div>}
  {message&&<p role="status" className="mt-3 break-all text-sm">{message}</p>}
 </details>;
}
