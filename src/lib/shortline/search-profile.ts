import { SERVER_BLOCKED_FEATS } from "./mount"
import { LIVE_BASE_FEATURES } from "./spec"

/** Additive search restriction; existing tasks retain their frozen feature pools. */
export function filterSearchFeatures(active: readonly number[], allowed?: readonly number[]): number[] {
  const pool = allowed ? active.filter((id) => allowed.includes(id)) : [...active]
  if (!pool.length) throw new Error("当前训练数据没有所选搜索范围内的可用特征")
  return pool
}

export function enhancedShortlineSearch(seed: number) {
  return {
    seed,
    combo_super: true,
    live_entry_gate: .25,
    // Match the shortline v2 feature matrix, not the separate v3 factor table.
    search_feature_ids: LIVE_BASE_FEATURES.filter((i) => i < 52 && !SERVER_BLOCKED_FEATS.has(i) && ![17,18,33,34].includes(i)),
    seed_tokens: [
      [1, 103], [4, 102], [45, 111], [49, 4, 66], // continuation and flow
      [8, 71], [39, 104],                         // pullback / range position
      [20, 11, 66], [12, 23, 66],                 // volume-backed price movement
      [3, 8, 71, 64], [2, 26, 67],               // trend/pullback and volatility scaling
    ],
  }
}
