import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {useAuthStore} from '@/stores/auth'
import {getFactorTaskHealth,refreshFactorTaskHealth,runFactorTaskReview,type FactorTaskHealth,type FactorTaskReview} from '@/lib/factor-task-review'

const money=(n?:number)=>n==null?'—':`${n.toFixed(2)} U`
const percent=(n?:number|null)=>n==null?'—':`${(n*100).toFixed(1)}%`
const names:Record<string,string>={signal_only:'仅因子信号',full_rules:'全部任务规则',full_rules_2x:'双倍交易成本',without_lock:'不启用锁利',without_loss_cooldown:'不启用亏损冷静期'}

export function TaskFactorEvidence({snapshot,report}:{snapshot?:FactorTaskHealth|null;report?:FactorTaskReview|null}) {
  const health=snapshot?.health,actual=snapshot?.actual
  return <div className="space-y-3 text-xs">
    {health&&<div className="space-y-1">
      <p>近期因子观察：{health.status==='ok'?`IC ${health.trailing_ic?.toFixed(4)??'—'} · ${health.ic_pairs??250} 个已知收益配对`:
        health.reason||'等待检查'}</p>
      {health.checked_at&&<p className="text-[var(--text-muted)]">检查时间 {new Date(health.checked_at).toLocaleString()} · 行情截至 {health.label_end||'—'}</p>}
      {health.status==='ok'&&<p className="text-[var(--text-muted)]">下一根开盘收益相关性，不代表盈利概率；研究成本为假设手续费和滑点，不含资金费率。</p>}
      {health.structural?.errors.map((error,i)=><p key={i} className="text-amber-500">旧配方复审：{error}</p>)}
    </div>}
    {actual&&<div className="border-t border-[var(--border)] pt-2 space-y-1">
      <p>实际已结束交易：{actual.rounds} 轮 · 胜率 {percent(actual.win_rate)} · 扣手续费 {money(actual.net_profit)}</p>
      <p className="text-[var(--text-muted)]">截至检查时最近 {actual.recent_rounds} 轮 {money(actual.recent_net_profit)}；不含资金费率和未平仓浮盈亏。{actual.unresolved>0&&`${actual.unresolved} 轮盈亏待确认。`}</p>
    </div>}
    {report&&<div className="border-t border-[var(--border)] pt-3 space-y-2">
      <p className="font-medium">固定当前配置的历史情景回放</p>
      <p className="text-[var(--text-muted)]">{report.variants.full_rules.start} 至 {report.variants.full_rules.end} · 执行 K 线 {report.variants.full_rules.execution_seconds} 秒。与期间曾变更过配置的实盘收益不可直接等同。</p>
      <div className="overflow-auto"><table className="w-full text-left whitespace-nowrap"><thead className="text-[var(--text-muted)]"><tr><th className="pr-3">对照情景</th><th className="pr-3">结束轮次</th><th className="pr-3">已实现净额</th><th className="pr-3">含未平仓估值</th><th>最大回撤</th></tr></thead>
        <tbody>{Object.entries(report.variants).map(([key,v])=><tr key={key} className="border-t border-[var(--border)]"><td className="py-2 pr-3">{names[key]||key}</td><td>{v.rounds}</td><td className={v.realized_net>=0?'text-up':'text-down'}>{money(v.realized_net)}</td><td>{money(v.total_net)}</td><td>{money(v.max_drawdown)}</td></tr>)}</tbody></table></div>
      <p>资金费率：{report.variants.full_rules.funding_complete?'事件覆盖通过；已计入情景回放':'事件覆盖不足，回放不能认定执行合格'}</p>
      {report.path_sensitive&&<p className="text-amber-500">不同 OHLC 路径结果不同，不能把情景结果当作精确成交或收益上下界。</p>}
      {report.limitations.filter(issue=>!report.path_sensitive||!issue.includes('OHLC 路径')).map((issue,i)=><p key={i} className="text-amber-500">{issue}</p>)}
      <p className="text-[var(--text-muted)]">{report.note}</p>
      <p className="font-mono text-[10px] break-all text-[var(--text-muted)]">行情 SHA256 {report.bars_sha256}</p>
    </div>}
  </div>
}

export function TaskFactorReviewPanel({taskId,disabled=false}:{taskId:string;disabled?:boolean}) {
  const scope=useAuthStore(state=>`${state.user?.id||''}:${state.user?.trading_mode||''}`)
  const [snapshot,setSnapshot]=useState<FactorTaskHealth|null>(null)
  const [report,setReport]=useState<FactorTaskReview|null>(null)
  const [busy,setBusy]=useState('')
  const [error,setError]=useState<string|null>(null)
  const [days,setDays]=useState(30)
  const [fine,setFine]=useState(true)
  const generation=useRef(0)
  useEffect(()=>{
    const ticket=++generation.current;setSnapshot(null);setReport(null);setError(null);setBusy('')
    void getFactorTaskHealth(taskId).then(value=>{if(generation.current===ticket)setSnapshot(value)})
      .catch(e=>{if(generation.current===ticket)setError(e instanceof Error?e.message:String(e))})
    return()=>{++generation.current}
  },[taskId,scope])
  async function run(kind:'health'|'replay') {
    const ticket=generation.current;setError(null)
    setBusy(kind==='health'?'读取同源行情与已结束成交…':'下载 OKX 行情、结算费率并回放任务规则，可能需要数分钟…')
    try {
      if(kind==='health') {const value=await refreshFactorTaskHealth(taskId);if(generation.current===ticket)setSnapshot(value)}
      else {const value=await runFactorTaskReview(taskId,{days,include_fine:fine,source_fingerprint:snapshot?.source_fingerprint});if(generation.current===ticket)setReport(value)}
    } catch(e) {if(generation.current===ticket)setError(e instanceof Error?e.message:String(e))}
    finally {if(generation.current===ticket)setBusy('')}
  }
  return <section aria-label="任务因子复审" className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
    <h2 className="text-sm font-medium">任务因子复审</h2>
    <p className="text-xs text-[var(--text-muted)]">比较信号、交易成本与当前任务规则的影响。此处只生成观察和回放报告。</p>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button size="sm" variant="outline" disabled={disabled||!!busy} onClick={()=>void run('health')}>刷新健康数据</Button>
      <label>回看 <select aria-label="任务回看天数" className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1" value={days} disabled={disabled||!!busy} onChange={e=>setDays(Number(e.target.value))}>{[7,14,30,60].map(day=><option key={day} value={day}>{day} 天</option>)}</select></label>
      <label className="flex gap-1 items-center"><input type="checkbox" checked={fine} disabled={disabled||!!busy} onChange={e=>setFine(e.target.checked)}/>使用分钟执行行情</label>
      <Button size="sm" disabled={disabled||!!busy} onClick={()=>void run('replay')}>运行规则回放</Button>
    </div>
    {busy&&<p role="status" className="text-xs text-[var(--primary)]">{busy}</p>}
    {error&&<p role="alert" className="text-xs text-down">{error}</p>}
    <TaskFactorEvidence snapshot={snapshot} report={report}/>
  </section>
}
