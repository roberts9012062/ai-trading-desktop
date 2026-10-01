import { describe, expect, it } from "vitest"
import { researchGradeChampions } from "./backends/native-gpu-core"
import type { NativePreciseResult } from "@/lib/native-engine/types"

type RejectedRow = NativePreciseResult["rejected_candidates"][number]

function row(reasons: string[], composite = 1): RejectedRow {
  return {
    tokens: [0, 64],
    text: "RET → ADD",
    composite,
    metrics: { holdout_metrics: { sortino: 0.5, sortino_2x: -0.1 } },
    qualification: { status: "rejected", reasons },
  } as unknown as RejectedRow
}

describe("researchGradeChampions(研究级冠军分级)", () => {
  it("唯一拒因是 2× 成本压力 → 研究级", () => {
    const out = researchGradeChampions([row(["holdout_stress_failed_or_missing"])])
    expect(out).toHaveLength(1)
    expect(out[0]!.composite).toBe(1)
  })

  it("成本压力 + 实盘入场门槛(同为执行级) → 仍算研究级", () => {
    const out = researchGradeChampions([
      row(["holdout_stress_failed_or_missing", "holdout_live_entry_failed"]),
    ])
    expect(out).toHaveLength(1)
  })

  it("混入任何非执行级拒因(封存段亏损/WF/严格筛) → 不算", () => {
    expect(researchGradeChampions([
      row(["holdout_stress_failed_or_missing", "holdout_failed_or_missing"]),
      row(["wf_oos_fold_failed"]),
      row(["strict_screen_failed_or_unproven", "holdout_stress_failed_or_missing"]),
    ])).toHaveLength(0)
  })

  it("空拒因(不应出现)→ 不算,防空值混入冒充研究级", () => {
    expect(researchGradeChampions([row([])])).toHaveLength(0)
  })
})
