import { factorLabRequest } from "./factor-lab-api"

export interface EvolutionRecipe { groups: number[][]; weights: number[]; rationale?: string }
export interface EvolutionSource {
  kind: "favorite" | "shortline_favorite" | "favorites" | "task" | "candidate"
  ids?: Array<{kind: "favorite" | "shortline_favorite"; id: string}>
  folder_name?: string
  folder_id?: string
  text?: string
  task_created_at?: string
  pending_evolution?: string | null
  applied_evolution?: string | null
  id?: string
  name?: string
  symbol?: string | null
  timeframe?: string | null
  shortline?: boolean
  recipe?: EvolutionRecipe
  fingerprint?: string
  unavailable?: string
  start_date?: string
  end_date?: string
  data_channel?: string
}
export interface EvolutionSettings {
  train_ratio: number; test_recent_bars: number; walk_forward_folds: number
  fee_rate: number; slippage_bps: number; execution_model: "spot_long_flat" | "perp_next_open"
}
export interface EvolutionMetrics { bars: number; ann_ret: number; sortino: number; calmar: number; net_return: number; stress_ann_ret: number; stress_sortino: number; discrete_ann_ret?: number; discrete_sortino?: number; discrete_stress_ann_ret?: number;task_rule_net?:number;task_rule_stress_net?:number;task_rule_rounds?:number }
export interface EvolutionValidation {
  passed: boolean; train?: EvolutionMetrics; validation?: EvolutionMetrics; folds?: EvolutionMetrics[]
  holdout?: EvolutionMetrics; reasons?: string[]; funding_complete: boolean; wf_consistency?: number;version?:string
}
export interface EvolutionProgress {
  phase: string; message: string; round: number; completed_rounds: number; current: number; total: number; updated_at?: string
}
export interface FormulaDiagnostic { errors: string[]; warnings: Array<{code: string; index: number; message: string}>; depth: number; lookback: number; feature_ids: number[]; normalization_note?: string }
export interface FormulaEvidence {
  error?: string
  coverage?: {bars: number; warmup: number; start: string; end: string; train_end: string; sealed_visible: boolean}
  bars_sha256?: string; recipe_hash?: string; interpretation?: string
  diagnostics?: {errors: string[]; members: FormulaDiagnostic[]}
  regimes?: Record<string, {bars: number; long_share: number | null; short_share: number | null; mean_score: number | null}>
  points?: Array<{index: number; segment: string; bar: {time: string; open: number; high: number; low: number; close: number; volume?: number}; return_60: number; regime: string; score: number;
    members: Array<{weight: number; score: number; nodes: Array<{index: number; token: number; name: string; value: number}>}>}>
}
export interface EvolutionAudit {
  passed: boolean; reasons?: string[]; diagnostics?: FormulaEvidence["diagnostics"]
  tests?: Array<{name: string; passed: boolean}>
  causal_prefix?: {passed: boolean; max_error: number; prefix_bars: number}
  comparison?: {passed: boolean; baseline_available?: boolean; changes?: Record<string, number>}
  task_comparison?:{passed:boolean;changes?:Record<string,number>;model:string;exact:false}|null
}
export interface ResearchReport {
  decision: "accepted" | "awaiting_seal" | "rejected"; hypothesis: string
  facts: {validation_net_return?: number; validation_stress_ann_ret?: number; wf_consistency?: number; holdout_passed?: boolean | null; comparison?: EvolutionAudit["comparison"];task_rule_net?:number;task_rule_stress_net?:number}
  reasons: string[]; next_steps: string[]; limitations: string[]
}
export interface EvolutionReport { round: number; recipe?: EvolutionRecipe; text?: string; validation?: EvolutionValidation; sealed?: EvolutionValidation; error?: string; format_repairs?: number; proposal?: unknown;
  audit?: EvolutionAudit; evidence?: FormulaEvidence; review?: ResearchReport; inspections?: Array<{indices: number[]; bars_sha256: string}> }
export interface EvolutionJob {
  id: string; source: EvolutionSource; symbol: string; timeframe: string; data_channel: string
  status: "context" | "ready" | "paused" | "stopped" | "passed" | "exhausted" | "sealed_failed"
  round: number; max_rounds: number; recipe: EvolutionRecipe; settings: EvolutionSettings & Record<string, unknown>
  reports: EvolutionReport[]; coverage: Record<string, { total: number; read: number }>; cutoff: string
  history_note: string; bars_sha256: string; error?: string; sealed_used: boolean
  application?: {id: string; status: string}
  baseline?: EvolutionValidation & {error?: string}
  research_evidence?: FormulaEvidence
  runtime_evidence?: {available: boolean; reason?: string; note?: string; examples?: Array<{record: {id: string; time: string; reason?: string}; bars_used: number; matches_current_recipe?: boolean; point: NonNullable<FormulaEvidence["points"]>[number]}>}
  progress?: EvolutionProgress
}
const root = "/api/factor-lab/evolution"
export function canReplaceTaskEvolution(job:EvolutionJob):boolean {
  if(job.source.kind!=='task'||job.source.shortline)return true
  const last=job.reports.at(-1)
  return !!job.settings.task_policy&&last?.validation?.version==='factor-evolution-2026-10-18.1'&&last?.audit?.task_comparison?.passed===true
}
export const getEvolutionTargets = () => factorLabRequest<{ items: EvolutionSource[] }>(`${root}/targets`).then(r => r.items)
export const getEvolutionJob = (id: string) => factorLabRequest<EvolutionJob>(`${root}/jobs/${id}`)
export const getEvolutionProgress = (id: string) => factorLabRequest<Pick<EvolutionJob, "id" | "status" | "round" | "max_rounds" | "progress" | "coverage" | "error">>(`${root}/jobs/${id}/progress`, undefined, 5_000)
export function createEvolutionJob(body: {source: EvolutionSource; model_row_id: string; symbol: string; timeframe: string; data_channel: string; bars: unknown[]; settings: EvolutionSettings; max_rounds: number; hint: string}) {
  return factorLabRequest<EvolutionJob>(`${root}/jobs`, {method: "POST", body: JSON.stringify(body)}, 240_000)
}
export const stepEvolutionJob = (id: string) => factorLabRequest<EvolutionJob>(`${root}/jobs/${id}/step`, {method: "POST"}, 600_000)
export const resumeEvolutionJob = (id: string) => factorLabRequest<EvolutionJob>(`${root}/jobs/${id}/resume`, {method: "POST"})
export const stopEvolutionJob = (id: string) => factorLabRequest<{status: string}>(`${root}/jobs/${id}/stop`, {method: "POST"})
export const applyEvolutionJob = (id: string, action: "save" | "replace_favorite" | "replace_task", name: string) => factorLabRequest<{id: string; status: string; name?: string}>(`${root}/jobs/${id}/apply`, {method: "POST", body: JSON.stringify({action, name})})
export const cancelEvolutionReplacement = (id: string) => factorLabRequest<{status: string}>(`${root}/tasks/${id}/pending`, {method: "DELETE"})
export const getEvolutionTaskState = (id: string) => factorLabRequest<{pending_job_id: string | null; applied_job_id: string | null; task_status: string}>(`${root}/tasks/${id}/state`)
export const getEvolutionHistory = (id: string, offset: number) => factorLabRequest<{items: EvolutionReport[]}>(`${root}/jobs/${id}/history?offset=${offset}`)
