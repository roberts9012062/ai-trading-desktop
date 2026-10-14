"use client"
import { useEffect, useRef, useState } from "react"
import { listFactorFavorites, analyzeFactorSimilarity, type FactorFavoriteItem, type FactorSimilarityResult } from "@/lib/factor-lab-api"
import { isSingleFactorFavorite } from "@/lib/portfolio-favorite"
import {serverFactorFormulaKey} from "@/lib/factor-access"
import type { QuantParamsState } from "@/lib/quant-strategy"

export function MultiFactorParams({quant, onQuant, symbol, timeframe = "15m"}: {
  quant: QuantParamsState; onQuant: (q: QuantParamsState) => void; symbol: string; timeframe?: string
}) {
  const [favorites, setFavorites] = useState<FactorFavoriteItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [reports, setReports] = useState<FactorSimilarityResult[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const lastSymbol = useRef(symbol)
  useEffect(() => {if (lastSymbol.current !== symbol) {lastSymbol.current = symbol; onQuant({...quant, factorRecipe: undefined, factorNames: []})}}, [symbol, onQuant, quant])
  const groups = quant.factorRecipe?.groups ?? []
  const key = JSON.stringify(groups)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError("")
    listFactorFavorites(symbol || undefined).then(items => {
      if (!cancelled) setFavorites(items.filter(isSingleFactorFavorite))
    }).catch(e => { if (!cancelled) setError(String(e)) }).finally(() => {if (!cancelled) setLoading(false)})
    return () => {cancelled = true}
  }, [symbol])
  useEffect(() => {
    let cancelled = false
    setReports([]); setError("")
    if (groups.length < 2 || !symbol) {setAnalyzing(false); return}
    setAnalyzing(true)
    const periods = [...new Set([timeframe, "15m", "60m", "240m"])]
    const timer = setTimeout(() => {
      void Promise.allSettled(periods.map(tf => analyzeFactorSimilarity({symbol, timeframe: tf, token_groups: JSON.parse(key) as number[][]})))
        .then(results => {
          if (cancelled) return
          setReports(results.flatMap(r => r.status === "fulfilled" ? [r.value] : []))
          const failed = results.flatMap((r, i) => r.status === "rejected" ? [`${periods[i]}：${String(r.reason)}`] : [])
          setError(failed.join("；")); setAnalyzing(false)
        })
    }, 400)
    return () => {cancelled = true; clearTimeout(timer)}
  }, [key, symbol, timeframe])
  function toggle(f: FactorFavoriteItem) {
    const tokens = f.tokens as number[]
    const index = groups.findIndex(g => serverFactorFormulaKey(g) === serverFactorFormulaKey(tokens))
    const next = index >= 0 ? groups.filter((_, i) => i !== index) : [...groups, tokens]
    const names = index >= 0 ? (quant.factorNames ?? []).filter((_, i) => i !== index) : [...(quant.factorNames ?? []), f.name]
    onQuant({...quant, factorRecipe: {groups: next, weights: next.map(() => 1)}, factorNames: names})
  }
  return <div className="space-y-3 text-xs">
    <p className="text-[var(--text-secondary)]">在 {timeframe} 周期选择 2–5 个因子。所有公式在任务周期重新评分，按上一轮分数最接近本根 K 线涨跌幅者胜出。</p>
    {loading && <p>加载因子收藏…</p>}
    {!loading && !favorites.length && <p>请先在因子实验室收藏单因子公式。</p>}
    <div className="max-h-48 overflow-auto space-y-1">
      {favorites.map(f => {
        const checked = groups.some(g => serverFactorFormulaKey(g) === serverFactorFormulaKey(f.tokens as number[]))
        return <label key={f.id} title={f.text || f.name} className="flex items-center gap-2 rounded border border-[var(--border)] p-2">
          <input type="checkbox" checked={checked} disabled={!checked && groups.length >= 5} onChange={() => toggle(f)} />
          <span>{f.name} · 来源周期 {f.timeframe ?? "—"}</span>
        </label>
      })}
    </div>
    {groups.length > 0 && <div className="text-[var(--text-muted)]">已选 {groups.length}/5：{(quant.factorNames ?? []).join("、")}</div>}
    <div className="rounded border border-[var(--border)] p-2 space-y-2">
      <p className="font-medium">多周期契合度 {analyzing ? "· 分析中…" : ""}</p>
      <p className="text-[var(--text-muted)]">低契合度：历史表现重合较少，组合互补性更强。高契合度：评分和盈亏时段过于相似，可替换为趋势、反转、波动、量价等不同类别。强负相关也可能是同一信号的镜像，不能当成独立因子。契合度仅反映历史样本，不保证收益。</p>
      {reports.map(r => <div key={r.timeframe}>
        <p>{r.timeframe} · {r.bars} 根公共样本</p>
        {r.pairs.map(p => <p key={`${p.i}-${p.j}`} className={p.level === "high" ? "text-amber-400" : "text-[var(--text-secondary)]"}>
          {quant.factorNames?.[p.i] ?? `因子${p.i+1}`} / {quant.factorNames?.[p.j] ?? `因子${p.j+1}`}：契合度 {p.similarity.toFixed(1)}/10（{p.level === "high" ? "高，建议更换重复指标" : p.level === "low" ? "低，互补性较强" : "中"}）
        </p>)}
      </div>)}
      {error && <p role="alert" className="text-amber-400">{error}。缺少数据的周期不计算契合度。</p>}
      {!reports.length && !analyzing && groups.length >= 2 && <p>暂无有效契合度样本。</p>}
    </div>
    <p className="text-[var(--text-muted)]">实际分数 = 收盘价 ÷ 开盘价 − 1；1→1.5 为 +0.5，1→0.8 为 −0.2。胜者由上轮分数误差决定，当前分数作为下一轮交易依据；误差相同时按选择顺序优先。</p>
  </div>
}
