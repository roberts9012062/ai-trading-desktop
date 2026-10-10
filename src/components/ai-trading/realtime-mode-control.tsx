import { useState } from 'react'
import { Zap } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { AITradingTask } from '@/lib/ai-trading-api'
import type { Cadence } from '@/lib/realtime-factor/model'
import { startRealtime, stopRealtime } from '@/lib/realtime-factor/runtime'
import { useRealtimeFactorStore } from '@/stores/realtime-factor'

export function RealtimeInterval({value,onChange}:{value:Cadence;onChange:(value:Cadence)=>void}) {
  return <div className="flex flex-wrap gap-2" role="group" aria-label="秒级计算间隔">
    {([1,2,3,4,5] as const).map(n=><button key={n} type="button" aria-pressed={value===n} onClick={()=>onChange(n)} className={`rounded-md border px-3 py-1.5 text-sm ${value===n?'border-amber-400 bg-amber-500/15 text-amber-300':'border-[var(--border)] text-[var(--text-secondary)]'}`}>{n}秒</button>)}
  </div>
}

export function RealtimeModeControl({task}:{task:AITradingTask}) {
  const state=useRealtimeFactorStore(s=>s.tasks[task.id])
  const [open,setOpen]=useState(false), [interval,setInterval]=useState<Cadence>(3), [error,setError]=useState('')
  if(task.strategy_type!=='factor')return null
  const active=state?.state==='active', preparing=state?.state==='preparing', stopping=state?.state==='stopping'
  const other=!!task.realtime_mode?.active && !active && !preparing && state?.state!=='fallback'
  const toggle=()=>{
    setError('')
    if(active||preparing){void stopRealtime(task.id);return}
    setInterval(state?.interval??3);setOpen(true)
  }
  return <div onClick={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} className="mt-2 text-xs">
    <button type="button" role="switch" aria-checked={active} aria-label="秒级模式" disabled={task.status!=='running'||stopping||other} onClick={toggle}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 disabled:opacity-50 ${active?'border-amber-400/60 bg-amber-500/10 text-amber-300':'border-[var(--border)] text-[var(--text-muted)]'}`}>
      <Zap className="h-3.5 w-3.5"/>{active?`秒级运行 · ${state.interval}秒`:preparing?'准备中 · 点击取消':stopping?'正在恢复普通模式':other?`秒级运行 · 其他客户端`:'秒级模式'}
    </button>
    {state?.message && !active && <p role="status" className="mt-1 break-words text-[10px] text-[var(--text-muted)]">{state.message}</p>}
    {error&&!open&&<p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md" onClick={e=>e.stopPropagation()}>
        <DialogHeader><DialogTitle>开启秒级模式</DialogTitle></DialogHeader>
        <p className="text-sm text-[var(--text-secondary)]">保留{task.timeframe}周期，使用正在形成的K线计算因子，开仓和平仓均使用盘中信号。</p>
        <RealtimeInterval value={interval} onChange={setInterval}/>
        <p className="text-xs leading-relaxed text-amber-300">请保持当前客户端运行。准备期间沿用普通模式；关闭客户端将恢复原分析频率，异常失联5秒后由服务器接管。止损止盈保护持续有效。</p>
        {error&&<p role="alert" className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={()=>setOpen(false)}>取消</Button>
          <Button onClick={()=>{setOpen(false);void startRealtime(task,interval).catch(e=>setError(String(e)))}}>开始秒级模式</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}

export function RealtimeCreateOptions({enabled,interval,onEnabled,onInterval}:{enabled:boolean;interval:Cadence;onEnabled:(v:boolean)=>void;onInterval:(v:Cadence)=>void}) {
  return <div className="space-y-2 rounded-lg border border-amber-500/25 p-3">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>onEnabled(e.target.checked)}/><Zap className="h-4 w-4 text-amber-400"/>秒级模式（可选）</label>
    {enabled&&<><RealtimeInterval value={interval} onChange={onInterval}/><p className="text-[11px] leading-relaxed text-amber-300">创建后启动任务并准备本地计算，开平仓使用盘中信号。请保持客户端运行；退出恢复普通模式，失联5秒后服务器接管。准备期间按原频率运行。</p></>}
  </div>
}
