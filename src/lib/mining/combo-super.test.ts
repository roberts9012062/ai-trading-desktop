import { describe, expect, it } from "vitest"
import { oosEvidence, selectComboMembers } from "./combo-super"
import type { Champion } from "@/lib/factor-lab-api"

function champion(opts: {
  composite?: number
  overfit?: boolean
  status?: string
  testSortino?: number
  oosSortino?: number
  insufficient?: boolean
}): Champion {
  return {
    tokens: [Math.floor(Math.random() * 1000)],
    text: "x",
    composite: opts.composite ?? 1,
    metrics: {
      ann_ret: 0, sortino: 1, calmar: 1, ts_ic: 0, symmetry: 0.5, turnover_q: 0,
      oos_sortino: opts.oosSortino ?? (opts.testSortino ?? -1),
      oos_mult: 1,
      consistency: 1, composite: opts.composite ?? 1, avg_turnover: 0, exposure: 0,
      ...(opts.overfit ? { overfit_warning: "测试段亏损" } : {}),
      ...(opts.status ? { candidate_status: opts.status } : {}),
      ...(opts.testSortino != null ? { test_metrics: { ann_ret: 0, sortino: opts.testSortino, calmar: 0, ts_ic: 0, avg_turnover: 0, exposure: 0, bars: 10 } } : {}),
      ...(opts.insufficient ? { insufficient_samples: true } : {}),
    },
  }
}

describe("oosEvidence(样本外盈利证据)", () => {
  it("测试段 sortino 优先,缺省回退 oos_sortino", () => {
    expect(oosEvidence(champion({ testSortino: 0.4, oosSortino: -0.2 }))).toBe(0.4)
    expect(oosEvidence(champion({ oosSortino: -0.2 }))).toBe(-0.2)
  })
})

describe("selectComboMembers(组合因子成员选择)", () => {
  it("优质因子 ≥2 → 全部取优质,composite 降序,上限 5", () => {
    const out = selectComboMembers([
      champion({ composite: 1, status: "holdout_passed" }),
      champion({ composite: 3, status: "validation_passed" }),
      champion({ composite: 2 }),
      champion({ composite: 5, overfit: true }),
      champion({ composite: 4, status: "rejected" }),
      champion({ composite: 6, status: "exploratory" }),
      champion({ composite: 0.5, status: "holdout_passed" }),
    ])
    expect(out?.source).toBe("quality")
    expect(out?.members.map((c) => c.composite)).toEqual([3, 2, 1, 0.5])
  })

  it("优质 <2 → 回捞样本外仍盈利的失败因子(按 OOS 证据降序)", () => {
    const out = selectComboMembers([
      champion({ composite: 9, overfit: true, testSortino: -1 }),
      champion({ composite: 1, overfit: true, testSortino: 0.3 }),
      champion({ composite: 2, overfit: true, testSortino: 0.8 }),
      champion({ composite: 8, overfit: true, testSortino: -0.5 }),
    ])
    expect(out?.source).toBe("rescued")
    expect(out?.members.map((c) => c.metrics.test_metrics?.sortino)).toEqual([0.8, 0.3])
  })

  it("样本外无一盈利 → 放宽到全量按综合分(仍凑齐 2 个)", () => {
    const out = selectComboMembers([
      champion({ composite: 7, overfit: true, testSortino: -0.4 }),
      champion({ composite: 2, overfit: true, testSortino: -0.1 }),
    ])
    expect(out?.source).toBe("rescued")
    expect(out?.members.map((c) => c.composite)).toEqual([7, 2])
  })

  it("优质 1 个 + 回捞混合,成员 ≤5 且优质在列", () => {
    const lone = champion({ composite: 1, status: "holdout_passed" })
    const out = selectComboMembers([
      lone,
      champion({ composite: 5, overfit: true, testSortino: 0.2 }),
      champion({ composite: 4, overfit: true, testSortino: 0.9 }),
      champion({ composite: 3, overfit: true, testSortino: 0.7 }),
      champion({ composite: 2, overfit: true, testSortino: 0.5 }),
      champion({ composite: 1.5, overfit: true, testSortino: 0.1 }),
    ])
    expect(out?.source).toBe("rescued")
    expect(out?.members).toHaveLength(5)
    expect(out?.members[0]).toBe(lone)
  })

  it("insufficient_samples 不算优质", () => {
    const out = selectComboMembers([
      champion({ composite: 1, insufficient: true, testSortino: 0.5 }),
      champion({ composite: 2, insufficient: true, testSortino: 0.4 }),
    ])
    expect(out?.source).toBe("rescued")
  })

  it("候选不足 2 个 → 无法组合返回 null", () => {
    expect(selectComboMembers([champion({})])).toBeNull()
    expect(selectComboMembers([])).toBeNull()
  })
})
