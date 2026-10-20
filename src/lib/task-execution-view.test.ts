import {expect,it} from 'vitest'
import {taskExecutionView} from './task-execution-view'
const now=Date.parse('2026-10-20T12:00:00Z')
const current={state:'running',role:'desktop',stale:false,checked_at:new Date(now).toISOString(),lease_until:new Date(now+20000).toISOString(),checkpoint_seq:3,recorded_status:'running'}
it('shows the confirmed location without changing the server task setting',()=>{
  expect(taskExecutionView(current,now)).toMatchObject({text:'最近确认：客户端运行',tone:'active'})
  expect(taskExecutionView({...current,role:'standby'},now)?.text).toBe('最近确认：备用执行器运行')
  expect(taskExecutionView(undefined,now)).toBeNull()
})
it('expires cached ownership even when an offline page cannot refresh',()=>{
  for(const value of [{...current,stale:true},{...current,lease_until:new Date(now-1).toISOString()},{...current,checked_at:'invalid'},{...current,checked_at:new Date(now+60000).toISOString()}]){
    expect(taskExecutionView(value,now)).toMatchObject({text:'执行状态待核对',tone:'pending'})
  }
  expect(taskExecutionView(current,now+21000)?.text).toBe('执行状态待核对')
})
it('keeps stop and unknown-result barriers visible and never infers a restart',()=>{
  expect(taskExecutionView({...current,state:'manual_flatten_required',stale:true},now)).toMatchObject({text:'任务已锁定，需手动平仓确认',tone:'blocked'})
  expect(taskExecutionView({...current,state:'waiting_reconciliation'},now)?.text).toBe('交易结果待核对')
  expect(taskExecutionView({...current,state:'waiting_checkpoint'},now)?.text).toBe('等待最新运行记录')
  expect(taskExecutionView({...current,state:'paused'},now)?.text).toBe('执行记录：已暂停')
})
