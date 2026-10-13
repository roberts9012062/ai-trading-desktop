import type {EvolutionReport, FormulaEvidence} from '@/lib/factor-evolution-api'

const pct = (value?: number | null) => value == null ? '—' : `${(value*100).toFixed(2)}%`
const number = (value: number) => Number.isFinite(value) ? value.toPrecision(7) : '不可用'
const regimeNames: Record<string,string> = {trend_down:'过去60根强下跌',trend_up:'过去60根强上涨',chop:'震荡'}

export function FormulaEvidencePanel({title,evidence}: {title:string; evidence?:FormulaEvidence}) {
  if (!evidence) return null
  const coverage=evidence.coverage
  return <details className="rounded-lg border border-[var(--border)] p-3 text-xs space-y-3">
    <summary className="cursor-pointer font-medium text-[var(--primary)]">{title} · K线与公式逐层数值</summary>
    {evidence.error&&<p className="text-down mt-2">取证未完成：{evidence.error}</p>}
    {coverage&&<p className="text-[var(--text-muted)] mt-2">{coverage.start} 至 {coverage.end} · {coverage.bars} 根 · 预热 {coverage.warmup} 根 · {coverage.sealed_visible?'包含封存':'封存不可见'}</p>}
    {evidence.diagnostics?.members.map((member,i)=><div key={i} className="space-y-1">
      <p>成员 {i+1} · 树深 {member.depth} · 累计算子窗口 {member.lookback} 根</p>
      {member.errors.map((error,j)=><p key={`e${j}`} className="text-down">{error}</p>)}
      {member.warnings.map((warning,j)=><p key={`w${j}`} className="text-amber-500">{warning.message}</p>)}
      {member.normalization_note&&<p className="text-[var(--text-muted)]">{member.normalization_note}</p>}
    </div>)}
    {evidence.regimes&&<div className="overflow-auto"><table className="w-full text-left whitespace-nowrap"><thead className="text-[var(--text-muted)]"><tr><th>过去价格状态</th><th>根数</th><th>偏多占比</th><th>偏空占比</th></tr></thead><tbody>{Object.entries(evidence.regimes).map(([name,r])=><tr key={name} className="border-t border-[var(--border)]"><td className="py-2 pr-3">{regimeNames[name]||name}</td><td>{r.bars}</td><td>{pct(r.long_share)}</td><td>{pct(r.short_share)}</td></tr>)}</tbody></table></div>}
    <div className="space-y-2">{evidence.points?.map(point=><details key={point.index} className="border-t border-[var(--border)] pt-2">
      <summary className="cursor-pointer">索引 {point.index} · {point.bar.time} · 收盘 {number(point.bar.close)} · 分数 <span className={point.score>0?'text-up':'text-down'}>{number(point.score)}</span></summary>
      <p className="mt-2 text-[var(--text-muted)]">O {point.bar.open} / H {point.bar.high} / L {point.bar.low} / C {point.bar.close} · 60根涨跌 {pct(point.return_60)} · {regimeNames[point.regime]||point.regime}</p>
      {point.members.map((member,i)=><div key={i} className="mt-2 overflow-auto"><p className="py-1">成员 {i+1} · 权重 {pct(member.weight)} · 最终分数 {number(member.score)}</p><table className="w-full text-left whitespace-nowrap font-mono text-[10px]"><thead><tr><th>步骤</th><th>token</th><th>特征 / 算子</th><th>实测输出</th></tr></thead><tbody>{member.nodes.map(node=><tr key={node.index} className="border-t border-[var(--border)]"><td className="py-1">{node.index}</td><td>{node.token}</td><td className="pr-3">{node.name}</td><td>{number(node.value)}</td></tr>)}</tbody></table></div>)}
    </details>)}</div>
    {evidence.interpretation&&<p className="text-[10px] text-[var(--text-muted)]">{evidence.interpretation}</p>}
    {evidence.bars_sha256&&<p className="font-mono text-[10px] break-all text-[var(--text-muted)]">行情 SHA256 {evidence.bars_sha256}</p>}
  </details>
}

export function EvolutionResearchReport({report}: {report:EvolutionReport}) {
  const review=report.review, audit=report.audit
  if (!review&&!audit) return null
  return <div aria-label="因子进化研究报告" className="space-y-3 text-xs">
    <h3 className="font-medium">{review?.decision==='accepted'?'研究与执行验收通过':review?.decision==='awaiting_seal'?'自动审查通过，等待封存验收':'自动审查未通过'}</h3>
    <div className="rounded-lg bg-[var(--bg-primary)] p-3 space-y-1"><p className="text-[var(--text-muted)]">AI 研究判断（待实测的经济假设）</p><p className="whitespace-pre-wrap leading-relaxed">{review?.hypothesis||report.recipe?.rationale||'模型未提供经济假设'}</p></div>
    {audit?.tests&&<ul className="grid sm:grid-cols-2 gap-2">{audit.tests.map(test=><li key={test.name} className={test.passed?'text-up':'text-down'}>{test.passed?'✓':'✕'} {test.name}</li>)}</ul>}
    {review&&<><p>服务器实测：验证累计净收益 <strong>{pct(review.facts.validation_net_return)}</strong> · 双倍成本年化 {pct(review.facts.validation_stress_ann_ret)} · WF 正收益比例 {pct(review.facts.wf_consistency)}</p>
      {Object.entries(review.facts.comparison?.changes||{}).length>0&&<p className="text-[var(--text-muted)]">相对原配方：普通年化变化 {pct(review.facts.comparison?.changes?.ann_ret)} · 双倍成本年化变化 {pct(review.facts.comparison?.changes?.stress_ann_ret)} · 离散双倍成本变化 {pct(review.facts.comparison?.changes?.discrete_stress_ann_ret)}</p>}
      {review.reasons.map((reason,i)=><p key={i} className="text-down">{reason}</p>)}
      <div><p className="font-medium mb-1">解决方案与下一步</p><ol className="list-decimal pl-5 space-y-1">{review.next_steps.map((step,i)=><li key={i}>{step}</li>)}</ol></div>
      <p className="text-[10px] text-[var(--text-muted)]">{review.limitations.join('；')}</p></>}
    {!!report.inspections?.length&&<p className="text-[var(--text-muted)]">AI 已主动取证 {report.inspections.length} 次，共查询 {report.inspections.reduce((sum,r)=>sum+r.indices.length,0)} 个索引。</p>}
    <FormulaEvidencePanel title="候选复算证据" evidence={report.evidence}/>
  </div>
}
