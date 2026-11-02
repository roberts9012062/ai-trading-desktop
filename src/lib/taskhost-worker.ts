import {invoke,isTauri} from '@tauri-apps/api/core';
import {hostSession} from './taskhost-client';

/** One explicit native maintenance request; it never creates or resumes a task. */
export async function prepareLocalWorker(accountID:string,action:'prepare-delete'|'prepare-resume'|'confirm-flat'){
 const session=hostSession(),scope=session?.mode==='standalone'?session.scope:session?.centerScope;
 if(!isTauri()||!scope||!/^[a-f0-9]{64}$/.test(accountID))throw new Error('请先在本机绑定同一中心身份并启动 Go 观察进程');
 const args={scope,accountId:accountID,input:null,allowTrading:false};
 const status=await invoke<{generation:string;execution_authority:false;active?:boolean;exited?:boolean;active_elsewhere?:boolean}>('taskhost_go_worker',{...args,action:'status',expectedGeneration:null});
 if(hostSession()!==session)throw new Error('会话已变化');
 if(status.execution_authority!==false||!status.active||status.exited||status.active_elsewhere||!/^\d{1,19}$/.test(status.generation))throw new Error('请先在本机启动该账户的 Go 观察进程');
 const result=await invoke<{state:string;epoch?:string;refresh_required:true;execution_authority:false}>('taskhost_go_worker',{...args,action,expectedGeneration:status.generation});
 if(hostSession()!==session)throw new Error('会话已变化');
 const expected={"prepare-delete":"delete_ready","prepare-resume":"preparing","confirm-flat":"recovery_confirmed"}[action];
 if(result.execution_authority!==false||result.refresh_required!==true||result.state!==expected)throw new Error('本机准备结果未确认');return result;
}
