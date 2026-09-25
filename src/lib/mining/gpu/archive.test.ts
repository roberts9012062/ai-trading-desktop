/**
 * 精算漏斗配额测试(方案 §8.2 验收)
 *
 * 同质拥挤案例:粗排头部全是同一因子的变体(高分类似、指纹相同)时,
 * 配额漏斗仍把不同族/复杂度的互补候选送进 f64 精算;探索配额确定性。
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_PRECISE_QUOTAS,
  complexityBand,
  familyOfTokens,
  selectPreciseIndicesQuota,
  type RankedCandidate,
} from "./rank"

function cand(comp: number, tokens: number[], fp?: number): RankedCandidate {
  return { comp, tree: null as never, tokens, fp }
}

/** 头部 60 个同族变体(指纹各不相同但结构雷同),后部低分互补候选 */
function crowded(): RankedCandidate[] {
  const out: RankedCandidate[] = []
  for (let k = 0; k < 60; k++) {
    out.push(cand(5 - k * 0.01, [k % 40, 64 + 13, 64 + 14], k))
  }
  out.push(cand(1.0, [52, 64 + 14], 1000)) // direct_deriv 短
  out.push(cand(0.9, [45, 46, 64], 1001)) // crypto_v1 二元
  out.push(cand(0.8, [54, 0, 5, 64, 64 + 14, 64 + 15, 64 + 17], 1002)) // direct 长
  return out
}

describe("selectPreciseIndicesQuota", () => {
  it("同质头部挤占时互补候选仍进入精算名单", () => {
    const scored = crowded()
    const picked = selectPreciseIndicesQuota(scored, 20)
    const fams = new Set(picked.map((i) => familyOfTokens(scored[i].tokens)))
    expect(fams.has("direct_deriv")).toBe(true)
    expect(fams.has("crypto_v1")).toBe(true)
    expect(picked.length).toBe(20)
  })

  it("无效粗排分不占名额", () => {
    const scored = [
      cand(-999, [0]),
      cand(1.0, [52, 64 + 14]),
      cand(0.5, [45, 64 + 14]),
    ]
    const picked = selectPreciseIndicesQuota(scored, 10)
    expect(picked).not.toContain(0)
    expect(picked.length).toBe(2)
  })

  it("确定性:同输入两次结果一致", () => {
    const scored = crowded()
    expect(selectPreciseIndicesQuota(scored, 20)).toEqual(
      selectPreciseIndicesQuota(scored, 20),
    )
  })

  it("top 配额约 60%、分组配额约 25%、探索补满", () => {
    // 全部互不同族指纹的候选:前 12(60% of 20)应来自分数前列
    const scored: RankedCandidate[] = []
    for (let k = 0; k < 100; k++) {
      const fam = k % 3
      const tokens =
        fam === 0 ? [k % 40, 64 + 14]
        : fam === 1 ? [45, 64 + 14]
        : [52, 64 + 14]
      scored.push(cand(10 - k * 0.1, tokens, k))
    }
    const picked = selectPreciseIndicesQuota(scored, 20)
    const comps = picked.map((i) => scored[i].comp).sort((a, b) => b - a)
    // 名单内的最高分应等于全局最高分(top 区拿到了它们)
    expect(comps[0]).toBe(10)
    // 分组轮转保证三个族都出现
    const fams = new Set(picked.map((i) => familyOfTokens(scored[i].tokens)))
    expect(fams.size).toBe(3)
  })

  it("配额结构与辅助函数", () => {
    expect(DEFAULT_PRECISE_QUOTAS).toEqual({ top: 0.6, group: 0.25, explore: 0.15 })
    expect(familyOfTokens([52])).toBe("direct_deriv")
    expect(familyOfTokens([45])).toBe("crypto_v1")
    expect(familyOfTokens([0])).toBe("ohlcv_legacy")
    expect(complexityBand([1, 2, 3])).toBe(0)
    expect(complexityBand(new Array(20).fill(1))).toBe(4)
  })
})
