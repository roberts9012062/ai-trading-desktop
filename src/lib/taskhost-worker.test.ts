import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {enterStandalone,logoutHost} from './taskhost-client';
import {prepareLocalWorker,parseLocalGoWorkerStatus,localGoDataNotice} from './taskhost-worker';
const bridge=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:bridge,isTauri:()=>true}));
beforeEach(()=>{vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()});logoutHost();bridge.mockReset();enterStandalone({scope:'taskhost:standalone:user',centerUserID:'user'});});
afterEach(()=>{logoutHost();vi.unstubAllGlobals();});
it('uses a current native generation and only prepares deletion, never deletes a task',async()=>{
 bridge.mockResolvedValueOnce({active:true,exited:false,generation:'9007199254740993',execution_authority:false}).mockResolvedValueOnce({state:'delete_ready',epoch:'8',refresh_required:true,execution_authority:false});
 await expect(prepareLocalWorker('a'.repeat(64),'prepare-delete')).resolves.toMatchObject({state:'delete_ready'});
 expect(bridge.mock.calls.map(([,a])=>a.action)).toEqual(['status','prepare-delete']);expect(bridge.mock.calls[1][1].expectedGeneration).toBe('9007199254740993');expect(bridge.mock.calls[1][1].allowTrading).toBe(false);
});
it('does not send a command when the native process is absent or belongs to another account',async()=>{bridge.mockResolvedValue({active:true,active_elsewhere:true,generation:'1',execution_authority:false});await expect(prepareLocalWorker('a'.repeat(64),'confirm-flat')).rejects.toThrow('观察进程');expect(bridge).toHaveBeenCalledTimes(1);});
it('does not treat a native preparation as execution authority',async()=>{bridge.mockResolvedValueOnce({active:true,generation:'1',execution_authority:false}).mockResolvedValueOnce({state:'recovery_confirmed',refresh_required:true,execution_authority:true});await expect(prepareLocalWorker('a'.repeat(64),'confirm-flat')).rejects.toThrow('未确认');});
it('accepts legacy missing telemetry as unknown, and shows fresh fallback outage without stop or execution authority',()=>{
 const raw={installed:true,configured:true,generation:'9007199254740993',execution_authority:false,status:{state:'running',event:'status',checkpoint_seq:'1',error_code:''}};
 expect(parseLocalGoWorkerStatus(raw,'a'.repeat(64)).status).toMatchObject({data_source:'none',data_stale:true});
 const parsed=parseLocalGoWorkerStatus({...raw,status:{...raw.status,data_source:'collection',data_code:'okx_direct_unavailable',data_observed_at:new Date().toISOString(),data_stale:false}},'a'.repeat(64));
 expect(parsed.status?.data_stale).toBe(false);expect(localGoDataNotice(parsed.status)).toContain('API Collection');expect(parsed.execution_authority).toBe(false);expect(parsed).not.toHaveProperty('shutdown_acknowledged');
 expect(()=>parseLocalGoWorkerStatus({...raw,status:{...raw.status,data_code:'synthetic-secret-response'}},'a'.repeat(64))).toThrow('数据状态');
 expect(localGoDataNotice({...parsed.status!,data_code:'authentication_failed'})).toContain('Passphrase');expect(localGoDataNotice({...parsed.status!,data_code:'authentication_failed'})).not.toContain('购买');
 expect(parseLocalGoWorkerStatus({...raw,status:{...raw.status,data_source:'direct',data_code:'authentication_failed',data_observed_at:new Date().toISOString(),data_stale:false}},'a'.repeat(64)).status?.data_stale).toBe(true);
});
