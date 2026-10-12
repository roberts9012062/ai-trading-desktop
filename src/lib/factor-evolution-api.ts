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
export interface EvolutionMetrics { bars: number; ann_ret: number; sortino: number; calmar: number; net_return: number; stress_ann_ret: number; stress_sortino: number; discrete_ann_ret?: number; discrete_sortino?: number; discrete_stress_ann_ret?: number }
export interface EvolutionValidation {
  passed: boolean; train?: EvolutionMetrics; validation?: EvolutionMetrics; folds?: EvolutionMetrics[]
  holdout?: EvolutionMetrics; reasons?: string[]; funding_complete: boolean; wf_consistency?: number
}
export interface EvolutionReport { round: number; recipe?: EvolutionRecipe; text?: string; validation?: EvolutionValidation; sealed?: EvolutionValidation; error?: string }
export interface EvolutionJob {
  id: string; source: EvolutionSource; symbol: string; timeframe: string; data_channel: string
  status: "context" | "ready" | "paused" | "stopped" | "passed" | "exhausted" | "sealed_failed"
  round: number; max_rounds: number; recipe: EvolutionRecipe; settings: EvolutionSettings & Record<string, unknown>
  reports: EvolutionReport[]; coverage: Record<string, { total: number; read: number }>; cutoff: string
  history_note: string; bars_sha256: string; error?: string; sealed_used: boolean
  application?: {id: string; status: string}
  baseline?: EvolutionValidation & {error?: string}
}
const root = "/api/factor-lab/evolution"
export const getEvolutionTargets = () => factorLabRequest<{ items: EvolutionSource[] }>(`${root}/targets`).then(r => r.items)
export const getEvolutionJob = (id: string) => factorLabRequest<EvolutionJob>(`${root}/jobs/${id}`)
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
