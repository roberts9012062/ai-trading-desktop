import { useRealtimeFactorStore } from '@/stores/realtime-factor'

const ACTION={hold:'观望',close:'平仓',open_long:'开多',open_short:'开空'}
export function RealtimeAnalysis({taskId}:{taskId:string}) {
  const runtime=useRealtimeFactorStore(s=>s.tasks[taskId])
  return <div className="space-y-3">
    <p role="status" className="text-xs text-[var(--text-muted)]">{runtime?.message||'开启秒级模式后显示实时分析。'} · 每个任务保留最近50条，本地记录随客户端退出清空。</p>
    {!runtime?.rows.length?<p className="py-6 text-center text-sm text-[var(--text-muted)]">暂无秒级分析记录</p>:runtime.rows.map(row=><div key={row.id} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <time className="font-num text-[var(--text-muted)]">{new Date(row.at).toLocaleTimeString('zh-CN',{hour12:false})}</time>
        <span>价格 <span className="font-num">{row.price?Number(row.price.toPrecision(10)):'--'}</span></span>
        <span className={row.score==null?'':row.score<0?'text-down':'text-up'}>因子 {row.score?.toFixed(3)??'--'}</span>
        <span className="text-amber-300">{ACTION[row.action]}</span>
      </div>
      <p className="mt-1 break-words text-[var(--text-secondary)]">{row.reason}</p>
      <div className="mt-1 flex justify-between gap-2 text-[10px] text-[var(--text-muted)]"><span>{row.status}</span><span>行情 {new Date(row.marketAt).toLocaleTimeString('zh-CN',{hour12:false})}</span></div>
    </div>)}
  </div>
}
