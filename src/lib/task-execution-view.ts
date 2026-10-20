import type {TaskExecutionProjection} from './ai-trading-api'
export function taskExecutionView(value:TaskExecutionProjection|undefined,now=Date.now()):{text:string;tone:'active'|'pending'|'blocked'}|null{
  if(!value)return null
  if(value.state==='manual_flatten_required')return {text:'任务已锁定，需手动平仓确认',tone:'blocked'}
  if(value.state==='waiting_reconciliation')return {text:'交易结果待核对',tone:'blocked'}
  if(value.state==='server_sync_required')return {text:'等待服务器任务授权确认',tone:'pending'}
  if(value.state==='waiting_checkpoint')return {text:'等待最新运行记录',tone:'pending'}
  const checked=Date.parse(value.checked_at),until=Date.parse(value.lease_until)
  if(value.stale||!Number.isFinite(checked)||!Number.isFinite(until)||now-checked>30000||checked-now>5000||until<=now)return {text:'执行状态待核对',tone:'pending'}
  if(value.state==='paused')return {text:'执行记录：已暂停',tone:'pending'}
  if(value.state==='stopped')return {text:'执行记录：已停止',tone:'pending'}
  const roles:Record<string,string>={server:'服务器',desktop:'客户端',standby:'备用执行器'}
  if(value.state==='running'&&roles[value.role])return {text:`最近确认：${roles[value.role]}运行`,tone:'active'}
  return {text:'执行状态待核对',tone:'pending'}
}
