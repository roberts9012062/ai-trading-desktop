import type { MiningConfig } from "@/lib/mining/types"
import type { PortfolioResult } from "@/lib/factor-lab-api"

export type NativePrecision = "mixed" | "f64"
export interface NativeHello {
  engine_version: string
  backend: string
  fp64_supported: boolean
  device_name: string
  sm_count: number
  vram_mb: number
  precision: string
  selfcheck: { passed: boolean; token_count: number; eval_precision: "f64"; coarse_passed: boolean | null;
    features_passed: boolean; reports_passed: boolean; selection_passed: boolean; portfolio_passed?: boolean; sha256?: string }
}
export interface NativeEndpoint { port: number; token: string; pid: number; hello?: NativeHello }
export interface NativeEvaluatedCandidate { tokens: number[]; composite: number; metrics: Record<string, unknown> }
export interface NativeRankedCandidate { tokens: number[]; score: number }
export interface NativeStrictVerdict { tokens: number[]; pass: boolean; cross_scores: Record<string, unknown> }
export interface NativeChampion extends NativeEvaluatedCandidate { text: string }
export interface NativePrecisePayload {
  candidates?: number[][]; evaluated?: NativeEvaluatedCandidate[]; best_seen?: NativeEvaluatedCandidate[]
  prefetched_strict?: NativeStrictVerdict[]; trials?: number; final_generation?: boolean
  include_portfolio?: boolean
}
export interface NativeQualifiedCandidate extends NativeChampion {
  qualification: { status: "qualified" | "pending" | "rejected"; reasons: string[] }
}
export interface NativePreciseResult {
  gpu_buffer_mb?: number
  portfolio?: PortfolioResult | null
  champions: NativeQualifiedCandidate[]; best_seen: NativeEvaluatedCandidate[]
  research_candidates: NativeChampion[]
  pending_candidates: NativeQualifiedCandidate[]; rejected_candidates: NativeQualifiedCandidate[]
  qualification_requirements: Record<string, unknown>
}
export interface BarsMetadata { count: number; max_bars: 100000 | 200000 | 300000; snapshot_id?: string; [key: string]: unknown }
export type BarsColumns = Record<string, Float64Array>
export interface NativeFeatureInfo {
  feature_names: string[]; active_feature_ids: number[]; train_len: number; total_len: number
  periods: number; cost: number; features_source: string
}
export interface NativeProbeResult { available: boolean; reason?: string; detail?: string; hello?: NativeHello }
export interface NativeLaunchOptions { precision?: NativePrecision }
export type NativeMiningConfig = MiningConfig
