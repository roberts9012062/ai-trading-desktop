import type { EvolutionRecipe, EvolutionValidation } from "@/lib/factor-evolution-api"

export function EvolutionEvidence({metrics}: {metrics: Record<string, unknown>}) {
  const recipe = metrics.evolution_recipe as EvolutionRecipe
  const validation = metrics.evolution_validation as EvolutionValidation | undefined
  const sealed = metrics.evolution_sealed as EvolutionValidation | undefined
  const segments = [["训练", validation?.train], ["验证", validation?.validation], ...validation?.folds?.map((m, i) => [`WF ${i + 1}`, m] as const) || [], ["最终封存", sealed?.holdout]] as const
  return <div className="space-y-3 text-xs"><p className="text-[var(--text-muted)]">进化 {String(metrics.evolution_rounds || 0)} 轮 · {sealed?.passed ? "一次封存验收通过" : "未保存封存通过证据"}</p><p>{recipe?.rationale}</p><div className="overflow-auto"><table className="w-full text-left whitespace-nowrap"><thead className="text-[var(--text-muted)]"><tr><th className="py-2">区间</th><th>根数</th><th>扣费年化</th><th>Sortino</th><th>双倍成本年化</th><th>离散 Sortino</th></tr></thead><tbody>{segments.map(([name, m]) => <tr className="border-t border-[var(--border)]" key={name}><td className="py-2 pr-3">{name}</td><td>{m?.bars ?? "—"}</td><td>{m ? `${(m.ann_ret * 100).toFixed(2)}%` : "—"}</td><td>{m?.sortino.toFixed(2) ?? "—"}</td><td>{m ? `${(m.stress_ann_ret * 100).toFixed(2)}%` : "—"}</td><td>{m?.discrete_sortino?.toFixed(2) ?? "—"}</td></tr>)}</tbody></table></div><details><summary className="cursor-pointer text-[var(--primary)]">组合配方与冻结权重</summary><pre className="whitespace-pre-wrap break-all mt-2 text-[10px]">{JSON.stringify(recipe, null, 2)}</pre></details><p className="text-[10px] text-[var(--text-muted)]">次根开盘、无杠杆；阈值开平仓压力检查未包含任务全部止盈止损或短线逐笔成交规则。历史验证不保证未来收益。</p></div>
}
