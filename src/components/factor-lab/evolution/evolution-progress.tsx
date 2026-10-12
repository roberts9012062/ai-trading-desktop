import {useEffect, useState} from "react"
import {CheckCircle2, LoaderCircle, PauseCircle} from "lucide-react"
import type {EvolutionJob, EvolutionProgress} from "@/lib/factor-evolution-api"

const labels: Record<EvolutionJob["status"],string> = {context:"复盘任务历史",ready:"等待继续进化",paused:"已暂停",stopped:"已停止",passed:"全部验收通过",exhausted:"已达到迭代上限",sealed_failed:"最终封存未通过"}
export function EvolutionProgressPanel({job, running, preparing=false, stage="", progress, stepStartedAt}: {
  job:EvolutionJob|null; running:boolean; preparing?:boolean; stage?:string; progress?:EvolutionProgress; stepStartedAt?:number
}) {
  const [now,setNow]=useState(Date.now)
  const active=running||preparing
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer=setInterval(() => setNow(Date.now()),1000)
    return () => clearInterval(timer)
  },[active,stepStartedAt])
  if (!job&&!preparing) return null
  const completed=progress?.completed_rounds ?? Math.max(0,...(job?.reports||[]).map(r=>r.round))
  const maximum=job?.max_rounds||0
  const percentage=maximum ? Math.min(100,Math.round(completed/maximum*100)) : undefined
  const round=progress?.round ?? (job?.round||0)+(running&&job?.status!=="context"?1:0)
  const title=preparing?"准备进化数据":running?`第 ${round} 轮 · 进化进行中`:job?labels[job.status]:""
  const message=preparing?stage:running?(progress?.message||stage||"正在提交进化步骤…"):stage||progress?.message||title
  const folds=progress?.phase==="walk_forward"&&progress.total>0
  const seconds=stepStartedAt?Math.max(0,Math.floor((now-stepStartedAt)/1000)):0
  const Icon=active?LoaderCircle:job?.status==="passed"?CheckCircle2:PauseCircle
  return <section aria-label="因子进化进度" className="sticky top-0 z-20 rounded-xl border border-[var(--primary)]/40 bg-[var(--bg-secondary)] p-4 shadow-lg space-y-3">
    <div className="flex flex-wrap justify-between items-center gap-2 text-xs">
      <h2 className="font-medium text-sm flex items-center gap-2"><Icon size={17} className={active?"animate-spin text-[var(--primary)]":"text-[var(--primary)]"}/>{title}</h2>
      {!preparing&&job&&<span className="text-[var(--text-muted)]">{maximum?`已完成 ${completed} / ${maximum} 轮`:`已完成 ${completed} 轮 · 无限迭代`}</span>}
    </div>
    {!preparing&&maximum>0&&<div role="progressbar" aria-label="总轮次进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} className="h-2 rounded-full overflow-hidden bg-[var(--bg-primary)]"><div className="h-full bg-[var(--primary)] transition-[width] duration-300" style={{width:`${percentage}%`}} /></div>}
    <div className="flex flex-wrap justify-between items-center gap-2 text-xs">
      <span role="status" className="text-[var(--primary)]">{message}{folds&&` · ${progress.current} / ${progress.total} 折`}</span>
      {active&&stepStartedAt&&<span className="tabular-nums text-[var(--text-muted)]">本步骤已运行 {Math.floor(seconds/60)}分{String(seconds%60).padStart(2,"0")}秒</span>}
    </div>
    {active&&<div role="progressbar" aria-label={folds?"Walk-Forward 折数进度":"当前阶段运行中"} {...(folds?{"aria-valuemin":0,"aria-valuemax":progress.total,"aria-valuenow":progress.current}:{})} className="h-1.5 rounded-full overflow-hidden bg-[var(--bg-primary)]"><div className={`h-full rounded-full bg-[var(--primary)] ${folds?"transition-[width] duration-300":"w-1/3 animate-pulse"}`} style={folds?{width:`${progress.current/progress.total*100}%`}:undefined}/></div>}
    {active&&!folds&&<p className="text-[10px] text-[var(--text-muted)]">{preparing?"下载与数据校验完成后开始迭代。":"阶段状态每 2 秒刷新；模型生成耗时取决于所选服务，完成一轮后更新总进度。"}</p>}
  </section>
}
