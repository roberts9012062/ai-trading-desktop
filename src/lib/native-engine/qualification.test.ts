import { describe, expect, it } from "vitest"
import { fallbackRequirements, qualifyResearchCandidates, type QualificationRequirements } from "./qualification"
import type { Champion } from "@/lib/factor-lab-api"

const required: QualificationRequirements = { test_required: true, train_end: 700, wf_folds: 2, sample_sufficient: true,
  holdout_required: true, holdout_stress_required: true, live_fill_gate: true, live_entry_gate: .3, execution_required: true }
const candidate = (): Champion => ({ tokens: [0], text: "a", composite: 1, metrics: { sortino: 1, ann_ret: .1,
  native_strict_passed: true, test_metrics: { sortino: 1, live_fill_sortino: 1 }, execution_metrics: { sortino: 1 },
  walk_forward: { wf_stable: true, n_oos_folds: 2, folds: [
    { score_start: 700, score_end: 800, sortino: 1 }, { score_start: 800, score_end: 900, sortino: 1 }], },
  holdout_metrics: { sortino: 1, sortino_2x: 1, live_discrete_sortino: 1 },
} } as unknown as Champion)
describe("shared champion qualification metadata", () => {
  it("keeps the sealed report out of intermediate publication without ranking or backfill", () => {
    const row = candidate(), next = candidate(); next.tokens = [1]; next.composite = 2
    const before = JSON.stringify([row, next])
    expect(qualifyResearchCandidates([row, next], required, false).pending.map(row => row.tokens)).toEqual([[0], [1]])
    expect(qualifyResearchCandidates([row, next], required, true).champions.map(row => row.tokens)).toEqual([[0], [1]])
    expect(JSON.stringify([row, next])).toBe(before)
  })
  it("rejects missing or failed OOS fold evidence even when the aggregate is marked stable", () => {
    const row = candidate(), wf = row.metrics.walk_forward as unknown as Record<string, unknown>
    wf.folds = [{ in_train: true, test: { sortino: 10 } }]; wf.n_oos_folds = 0
    expect(qualifyResearchCandidates([row], required, true).champions).toEqual([])
    wf.folds = [{ in_train: false, test: { sortino: -1 } }]; wf.n_oos_folds = 1
    expect(qualifyResearchCandidates([row], required, true).rejected).toHaveLength(1)
  })
  it("does not invent DSR/PBO/turnover thresholds and fails explicit strict/holdout gates", () => {
    const row = candidate(); row.metrics.dsr = 0; row.metrics.pbo_proxy = 1; row.metrics.avg_turnover = 1
    expect(qualifyResearchCandidates([row], required, true).champions).toHaveLength(1)
    row.metrics.holdout_metrics!.sortino = -1
    expect(qualifyResearchCandidates([row], required, true).champions).toEqual([])
  })
  it("mirrors Python clamp and ties-to-even in the unchanged legacy split", () => {
    const cfg = { symbol: "ETHUSDT", timeframe: "15m", train_ratio: .5, population: 10, generations: 3, max_depth: 3, walk_forward_folds: 0 }
    expect(fallbackRequirements(cfg, 1001).train_end).toBe(500)
    expect(fallbackRequirements(cfg, 1003).train_end).toBe(502)
    expect(fallbackRequirements({ ...cfg, train_ratio: .999 }, 10000).train_end).toBe(9500)
  })
})
