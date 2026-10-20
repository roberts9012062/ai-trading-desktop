import {useSyncExternalStore} from 'react'
import type {TaskExecutionProjection} from '@/lib/ai-trading-api'
import {taskExecutionView} from '@/lib/task-execution-view'

let clock=Date.now(),timer:ReturnType<typeof setInterval>|undefined
const listeners=new Set<()=>void>()
function subscribe(callback:()=>void){
  listeners.add(callback)
  if(!timer){clock=Date.now();timer=setInterval(()=>{clock=Date.now();listeners.forEach(fn=>fn())},1000)}
  return()=>{listeners.delete(callback);if(!listeners.size){clearInterval(timer);timer=undefined}}
}
function ManagedStatus({execution}:{execution:TaskExecutionProjection}){
  const now=useSyncExternalStore(subscribe,()=>clock,()=>clock)
  const view=taskExecutionView(execution,now)!
  return <span aria-label="任务执行记录" title={`最近同步 ${execution.checked_at} · 记录序号 ${execution.checkpoint_seq}`} className={`text-[11px] leading-5 break-words ${view.tone==='active'?'text-emerald-400':view.tone==='blocked'?'text-amber-400':'text-[var(--text-muted)]'}`}>{view.text}</span>
}
export function TaskExecutionStatus({execution}:{execution?:TaskExecutionProjection}){
  return execution?<ManagedStatus execution={execution}/>:null
}
