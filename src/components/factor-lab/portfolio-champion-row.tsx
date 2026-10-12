"use client"

import { useEffect, useRef, useState } from "react"
import { addFactorFavorite, type PortfolioResult } from "@/lib/factor-lab-api"
import { favoriteTokensKey, portfolioFavoritePayload, portfolioMetrics, portfolioMode } from "@/lib/portfolio-favorite"
import { PortfolioCard } from "./portfolio-card"

/** A combination is a separate ranked entry; its members remain single-factor entries. */
export function PortfolioChampionRow({ portfolio, showCombo, showTest, showHoldout, showDsr, symbol, timeframe, favoritedKeys, onFavorited }: {
  portfolio: PortfolioResult
  showCombo: boolean
  showTest: boolean
  showHoldout: boolean
  showDsr: boolean
  symbol: string
  timeframe: string
  favoritedKeys?: Set<string>
  onFavorited?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const key = favoriteTokensKey(portfolio.members ?? [])
  const favorited = saved || !!favoritedKeys?.has(key)
  const metrics = portfolio.n_factors >= 2 ? portfolioMetrics(portfolio) : null
  const passed = portfolio.super_passed === true
  const canSave = passed && !!metrics && (portfolio.members?.length ?? 0) >= 2 && !!symbol && !!timeframe
  const columns = 7 + Number(showCombo) + 2 * Number(showTest) + Number(showHoldout) + Number(showDsr)
  useEffect(() => {
    if (favoritedKeys?.has(key)) setSaved(false)
  }, [favoritedKeys, key])

  async function save() {
    if (!canSave || favorited || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await addFactorFavorite(portfolioFavoritePayload(portfolio, symbol, timeframe))
      setSaved(true)
      window.dispatchEvent(new Event("strategy-favorites-changed"))
      onFavorited?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : "收藏失败，请重试")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return <>
    <tr className="border-t border-amber-500/30 bg-amber-500/5 cursor-pointer" onClick={() => setExpanded(value => !value)}>
      {showCombo && <td />}
      <td className="px-2 py-2 text-amber-500">组合</td>
      <td className="px-2 py-2 text-amber-500 font-medium">
        {passed ? "★ 超级因子" : "组合候选"}（{portfolio.n_factors} 成员 · {portfolioMode(portfolio) === "ic_weighted" ? "IC 加权" : "等权"}）
        <div className="text-[10px] text-[var(--text-muted)] font-normal">
          {passed ? "组合验收通过" : portfolio.super_passed === false ? "组合验收未通过" : "尚无超级因子验收结论"}
          {" · "}{portfolio.segment === "holdout" ? "封存段" : portfolio.segment === "test" ? "测试段" : "全段（含训练）"}
        </div>
      </td>
      <td className="px-2 py-2 text-right text-[var(--text-muted)]" title="组合没有单因子综合评分">—</td>
      <td className={`px-2 py-2 text-right font-num ${metrics && metrics.ann_ret >= 0 ? "text-up" : "text-down"}`}>{metrics ? `${(metrics.ann_ret * 100).toFixed(1)}%` : "—"}</td>
      <td className="px-2 py-2 text-right font-num">{metrics?.sortino.toFixed(2) ?? "—"}</td>
      <td className="px-2 py-2 text-right text-[var(--text-muted)]">—</td>
      {showTest && <><td className="px-2 text-right">{portfolio.segment === "test" && metrics ? `${(metrics.ann_ret * 100).toFixed(1)}%` : "—"}</td><td className="px-2 text-right">{portfolio.segment === "test" ? metrics?.sortino.toFixed(2) ?? "—" : "—"}</td></>}
      {showHoldout && <td className="px-2 text-right">{portfolio.segment === "holdout" ? metrics?.sortino.toFixed(2) ?? "—" : "—"}</td>}
      {showDsr && <td className="px-2 text-right">—</td>}
      <td className="px-2 py-2 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
        <button type="button" aria-expanded={expanded} className="text-[10px] text-[var(--primary)] hover:underline mr-2" onClick={() => setExpanded(value => !value)}>{expanded ? "收起数据" : "查看数据"}</button>
        <button type="button" className="text-[10px] text-[var(--primary)] hover:underline disabled:text-[var(--text-muted)] disabled:cursor-not-allowed" disabled={!canSave || favorited || saving} onClick={() => void save()} title={!canSave ? "完整且验收通过的组合可收藏为超级因子" : "收藏完整组合与本次评估数据"}>{saving ? "收藏中…" : favorited ? "已收藏" : "收藏"}</button>
      </td>
    </tr>
    {(expanded || error) && <tr className="border-t border-amber-500/20"><td colSpan={columns} className="p-2">
      {error && <p role="alert" className="text-down mb-2">{error}</p>}
      {expanded && <PortfolioCard portfolio={portfolio} />}
    </td></tr>}
  </>
}
