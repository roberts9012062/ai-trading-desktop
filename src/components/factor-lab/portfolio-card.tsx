"use client"

/**
 * 冠军组合推荐卡片 —— 等权/IC 加权组合 vs 最优单因子对照(深挖强化 M4)
 *
 * 因子实验室与超级因子挖掘共用。数据来自内核 evaluate_portfolio:
 * N 个低相关中等因子的组合通常优于单个最强因子(分散提升 Sortino),
 * 组合挂载在冠军表勾选 2-5 个即可(实盘侧 factor_np 支持加权组合)。
 *
 * 勾选「组合因子」的任务(super_passed 有值)追加超级因子口径:
 * 2× 成本四格对照 + 逐折 Sortino chips + 成员来源标签;
 * 通过 → 「★ 超级因子」徽标;不通过 → 红字「全部不合格」结论。
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

/** 逐折 1× Sortino chips(组合因子折检验;正=绿 负=红) */
function FoldChips(props: { sortinos?: number[] | null }): React.JSX.Element | null {
  const { sortinos } = props
  if (!sortinos?.length) return null
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[var(--text-muted)]">折检验</span>
      {sortinos.map((value, i) => (
        <span
          key={i}
          className={`font-num ${value > 0 ? "text-up" : "text-down"}`}
          title={`第 ${i + 1} 折样本外 Sortino(1× 成本)`}
        >
          #{i + 1} {value.toFixed(2)}
        </span>
      ))}
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
  const combo = portfolio.combo_super === true
  const superOk = combo && portfolio.super_passed === true
  const comboFailed = combo && portfolio.super_passed === false
  // 组合因子勾选但凑不齐 2 个成员:只给结论,不展示占位数字
  if (comboFailed && portfolio.n_factors === 0) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-down">
        组合测试未通过——可组合成员不足 2 个，本次挖掘产出全部不合格
      </div>
    )
  }
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-[11px] text-[var(--text-secondary)] font-num flex items-center gap-3 flex-wrap ${
        superOk
          ? "border-amber-500/40 bg-amber-500/5"
          : comboFailed
            ? "border-red-500/30 bg-red-500/5"
            : "border-[var(--border)] bg-[var(--bg-tertiary)]/30"
      }`}
    >
      {superOk && (
        <span className="text-amber-500 font-medium" title="组合通过验证区折检验(1×)与封存段 2× 成本压力">
          ★ 超级因子
          {portfolio.pass_mode === "ic_weighted" ? "（IC 加权口径）" : ""}
        </span>
      )}
      <span className="text-[var(--text-muted)]">
        冠军组合（{portfolio.n_factors} 因子 · 平均|相关性| {portfolio.avg_abs_corr}
        {seg ? ` · ${seg}` : ""}）
        {combo && (
          <span className="ml-1" title="成员来源:优质=合格+研究级因子;回捞=无优质时从失败因子里选样本外仍盈利者">
            {portfolio.combo_source === "rescued" ? "· 失败因子回捞" : "· 优质因子组合"}
          </span>
        )}
      </span>
      <MetricSpan label="等权" m={portfolio.equal} />
      {portfolio.ic_weighted && <MetricSpan label="IC 加权" m={portfolio.ic_weighted} />}
      {portfolio.equal_2x && (
        <span title="2× 成本压力口径(封存段)">
          等权 2× Sortino{" "}
          <span className={portfolio.equal_2x.sortino > 0 ? "text-up" : "text-down"}>
            {portfolio.equal_2x.sortino.toFixed(2)}
          </span>
        </span>
      )}
      {portfolio.ic_weighted_2x && (
        <span title="2× 成本压力口径(封存段)">
          IC 加权 2× Sortino{" "}
          <span className={portfolio.ic_weighted_2x.sortino > 0 ? "text-up" : "text-down"}>
            {portfolio.ic_weighted_2x.sortino.toFixed(2)}
          </span>
        </span>
      )}
      <FoldChips sortinos={portfolio.wf_fold_sortinos} />
      <span className="text-[var(--text-muted)]">
        （最优单因子 Sortino {portfolio.best_single.sortino.toFixed(2)}
        {portfolio.best_single_2x ? ` · 2× ${portfolio.best_single_2x.sortino.toFixed(2)}` : ""}）
      </span>
      {comboFailed && (
        <span className="text-down font-medium">
          组合测试未通过——本次挖掘产出全部不合格
        </span>
      )}
    </div>
  )
}
