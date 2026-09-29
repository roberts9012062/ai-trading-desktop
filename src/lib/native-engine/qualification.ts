import type { Champion } from "@/lib/factor-lab-api"
import type { MiningConfig } from "@/lib/mining/types"

export interface QualificationRequirements {
  test_required: boolean; train_end: number; wf_folds: number; sample_sufficient: boolean
  holdout_required: boolean; holdout_stress_required: boolean; live_fill_gate: boolean
  live_entry_gate: number; execution_required: boolean
}
type Dict = Record<string, unknown>
const dict = (v: unknown): Dict => v && typeof v === "object" && !Array.isArray(v) ? v as Dict : {}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const positive = (v: unknown, key = "sortino") => finite(dict(v)[key]) && (dict(v)[key] as number) > 0
function nonfinite(v: unknown): boolean {
  if (typeof v === "number") return !Number.isFinite(v)
  if (Array.isArray(v)) return v.some(nonfinite)
  if (v && typeof v === "object") return Object.values(v).some(nonfinite)
  return false
}

/** Same metadata gate as engine/qualification.py; never sorts or backfills. */
export function qualifyResearchCandidates(candidates: Champion[], required: QualificationRequirements, final: boolean) {
  const result: { champions: Champion[]; pending: Champion[]; rejected: Champion[] } = { champions: [], pending: [], rejected: [] }
  for (const candidate of candidates) {
    const metrics = candidate.metrics as unknown as Dict, reasons: string[] = []
    if (metrics.native_strict_passed !== true) reasons.push("strict_screen_failed_or_unproven")
    if (["exploratory", "rejected"].includes(String(metrics.candidate_status)) || metrics.overfit_warning) reasons.push("research_only_candidate")
    if (!required.sample_sufficient || metrics.insufficient_samples) reasons.push("insufficient_samples")
    const visible = final ? metrics : Object.fromEntries(Object.entries(metrics).filter(([key]) => !["holdout_metrics", "holdout_passed"].includes(key)))
    if (!finite(candidate.composite) || nonfinite(visible) || !["sortino", "ann_ret"].every(key => finite(metrics[key]))) reasons.push("nonfinite_metric")
    if (!required.test_required) reasons.push("oos_validation_unavailable")
    else if (!positive(metrics.test_metrics)) reasons.push("oos_validation_failed_or_missing")
    if (required.live_fill_gate && !positive(metrics.test_metrics, "live_fill_sortino")) reasons.push("live_fill_failed_or_missing")
    if (required.execution_required && !positive(metrics.execution_metrics)) reasons.push("execution_failed_or_missing")
    if (required.wf_folds > 0) {
      const wf = dict(metrics.walk_forward)
      if (wf.wf_stable !== true) reasons.push("wf_failed_or_missing")
      const oos: unknown[] = []
      for (const value of Array.isArray(wf.folds) ? wf.folds : []) {
        const fold = dict(value)
        if (fold.in_train === false) oos.push(fold.test)
        else if (!("in_train" in fold) && finite(fold.score_start) && finite(fold.score_end) &&
          Number.isInteger(fold.score_start) && Number.isInteger(fold.score_end) && fold.score_end > fold.score_start && fold.score_start >= required.train_end) oos.push(fold)
      }
      if (!finite(wf.n_oos_folds) || !Number.isInteger(wf.n_oos_folds) || wf.n_oos_folds < 1 || wf.n_oos_folds !== oos.length) reasons.push("wf_oos_evidence_missing")
      else if (!oos.every(row => positive(row))) reasons.push("wf_oos_fold_failed")
    }
    if (required.holdout_required && final) {
      if (!positive(metrics.holdout_metrics)) reasons.push("holdout_failed_or_missing")
      if (required.holdout_stress_required && !positive(metrics.holdout_metrics, "sortino_2x")) reasons.push("holdout_stress_failed_or_missing")
      if (required.live_entry_gate > 0 && "live_discrete_sortino" in dict(metrics.holdout_metrics) && !positive(metrics.holdout_metrics, "live_discrete_sortino")) reasons.push("holdout_live_entry_failed")
    }
    const status = reasons.length ? "rejected" : required.holdout_required && !final ? "pending" : "qualified"
    const item = { ...candidate, qualification: { status, reasons: status === "pending" ? ["holdout_sealed"] : [...new Set(reasons)] } }
    result[status === "qualified" ? "champions" : status].push(item)
  }
  return result
}

/** Read frozen split evidence, using the unchanged legacy split for old profiles. */
export function fallbackRequirements(config: MiningConfig, bars: number, candidate?: Champion): QualificationRequirements {
  const plan = dict(candidate?.metrics.split_plan), v2 = config.research_profile === "crypto_local_v2"
  let train = bars, test = 0
  if ((config.test_recent_bars ?? 0) > 0) {
    const cut = Math.max(120, bars - config.test_recent_bars!)
    if (bars - cut >= 120) { train = cut; test = bars - cut }
  } else if (config.train_ratio > 0) {
    const value = bars * Math.max(.05, Math.min(.95, config.train_ratio))
    const floor = Math.floor(value)
    const cut = value - floor === .5 ? floor + floor % 2 : Math.round(value)
    if (cut >= 120 && bars - cut >= 120) { train = cut; test = bars - cut }
  }
  if (v2) train = Array.isArray(plan.train) && finite(plan.train[1]) ? plan.train[1] : bars
  const sealed = v2 ? plan.sufficient === true && Array.isArray(plan.holdout) && Number(plan.holdout[1]) > Number(plan.holdout[0])
    : config.selection_v2 === true && test >= 240
  return { test_required: v2 ? plan.sufficient === true : test >= 120, train_end: train,
    wf_folds: config.walk_forward_folds || 0, sample_sufficient: !v2 || plan.sufficient === true,
    holdout_required: sealed, holdout_stress_required: v2, live_fill_gate: false,
    live_entry_gate: config.live_entry_gate ?? 0,
    execution_required: v2 && ["spot_long_flat", "perp_next_open"].includes(config.execution_model ?? "") }
}

export function qualifyFallback(candidates: Champion[], config: MiningConfig, bars: number, final: boolean) {
  const output: ReturnType<typeof qualifyResearchCandidates> = { champions: [], pending: [], rejected: [] }
  for (const row of candidates) {
    const reference = { ...row, metrics: { ...row.metrics, native_strict_passed: !row.metrics.overfit_warning &&
      !["exploratory", "rejected"].includes(row.metrics.candidate_status ?? "") } }
    const partition = qualifyResearchCandidates([reference], fallbackRequirements(config, bars, row), final)
    for (const key of ["champions", "pending", "rejected"] as const) output[key].push(...partition[key])
  }
  return output
}
