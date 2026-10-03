/**
 * 组合因子成员选择(勾选「组合因子」的任务在 CPU/GPU 路径共用)
 *
 * 分层口径与原生引擎 precise_ti.py 的组合成员池同构,两处必须保持一致:
 * 1. 优质因子优先(无 overfit 兜底标记、非 rejected/exploratory、样本充分),
 *    按 composite 降序截断 ≤5;
 * 2. 优质不足 2 个 → 回捞失败因子:先筛「样本外仍盈利(OOS Sortino>0)」者
 *    (按 OOS 证据降序),一个都没有再按综合分放宽;
 * 3. 成员上限 5,凑不齐 2 个返回 null(无法组合)。
 */
import type { Champion, PortfolioResult } from "@/lib/factor-lab-api"

export const MAX_COMBO_MEMBERS = 5

/** 样本外盈利证据:测试段 sortino 优先(资格门同源),缺省回退 OOS 后 25% sortino */
export function oosEvidence(champion: Champion): number {
  const test = champion.metrics.test_metrics?.sortino
  if (typeof test === "number" && Number.isFinite(test)) return test
  return Number.isFinite(champion.metrics.oos_sortino) ? champion.metrics.oos_sortino : -Infinity
}

/** 优质因子:样本外验证未被打回(无兜底警告、非 rejected/exploratory、样本足) */
function isQuality(champion: Champion): boolean {
  const m = champion.metrics
  if (m.overfit_warning) return false
  if (m.candidate_status === "rejected" || m.candidate_status === "exploratory") return false
  if (m.insufficient_samples) return false
  return true
}

export interface ComboMemberSelection {
  members: Champion[]
  /** quality=纯优质因子;rescued=含从失败因子回捞的成员 */
  source: "quality" | "rescued"
}

export function selectComboMembers(champions: Champion[]): ComboMemberSelection | null {
  if (champions.length < 2) return null
  const byComposite = (a: Champion, b: Champion) => b.composite - a.composite
  const quality = champions.filter(isQuality).sort(byComposite)
  if (quality.length >= 2) {
    return { members: quality.slice(0, MAX_COMBO_MEMBERS), source: "quality" }
  }
  const chosen = new Set(quality)
  const rest = champions.filter((c) => !chosen.has(c))
  // 回捞优先样本外仍盈利的失败因子(如只挂在 WF 某折或 2× 成本压力上的);
  // 一个都没有再放宽到全量按综合分。
  const profitable = rest
    .filter((c) => oosEvidence(c) > 0)
    .sort((a, b) => oosEvidence(b) - oosEvidence(a))
  const pool = profitable.length + quality.length >= 2 ? profitable : [...rest].sort(byComposite)
  const members = [...quality, ...pool].slice(0, MAX_COMBO_MEMBERS)
  if (members.length < 2) return null
  return { members, source: "rescued" }
}

/** 组合因子勾选任务的组合结果统一出口:已产出则补 combo_super 标记;
 *  勾选但无法组合(成员<2 或评估失败)时产出失败占位(n_factors=0),
 *  UI 据此显示「组合测试未通过——全部不合格」。 */
export function comboSuperOutcome(
  portfolio: PortfolioResult | null,
  requested: boolean,
): PortfolioResult | null {
  if (!requested) return portfolio
  if (portfolio) return { ...portfolio, combo_super: true }
  return {
    combo_super: true,
    super_passed: false,
    n_factors: 0,
    avg_abs_corr: 0,
    equal: { ann_ret: 0, sortino: 0, calmar: 0 },
    best_single: { ann_ret: 0, sortino: 0, calmar: 0 },
  }
}
