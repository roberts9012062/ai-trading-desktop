"use client"

/**
 * 冠军组合推荐卡片 —— 等权/IC 加权组合 vs 最优单因子对照(深挖强化 M4)
 *
 * 因子实验室与超级因子挖掘共用。数据来自内核 evaluate_portfolio:
 * N 个低相关中等因子的组合通常优于单个最强因子(分散提升 Sortino),
 * 组合挂载在冠军表勾选 2-5 个即可(实盘侧 factor_np 支持加权组合)。
 */

import type { PortfolioMetrics, PortfolioResult } from "@/lib/factor-lab-api"

function MetricSpan(props: { label: string; m: PortfolioMetrics }): React.JSX.Element {
  const { label, m } = props
  return (
    <span>
      {label} 年化{" "}
      <span className={m.ann_ret >= 0 ? "text-up" : "text-down"}>
        {(m.ann_ret * 100).toFixed(1)}%
      </span>{" "}
      · Sortino {m.sortino.toFixed(2)}
    </span>
  )
}

export function PortfolioCard(props: { portfolio: PortfolioResult }): React.JSX.Element {
  const { portfolio } = props
  const seg =
    portfolio.segment === "holdout"
      ? `封存段 ${portfolio.eval_bars ?? ""} 根`
      : portfolio.segment === "test"
        ? `测试段 ${portfolio.eval_bars ?? ""} 根`
        : null
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/30 px-3 py-2 text-[11px] text-[var(--text-secondary)] font-num flex items-center gap-3 flex-wrap">
      <span className="text-[var(--text-muted)]">
        冠军组合（{portfolio.n_factors} 因子 · 平均|相关性| {portfolio.avg_abs_corr}
        {seg ? ` · ${seg}` : ""}）
      </span>
      <MetricSpan label="等权" m={portfolio.equal} />
      {portfolio.ic_weighted && <MetricSpan label="IC 加权" m={portfolio.ic_weighted} />}
      <span className="text-[var(--text-muted)]">
        （最优单因子 Sortino {portfolio.best_single.sortino.toFixed(2)}）
      </span>
    </div>
  )
}
