import { describe, expect, it } from "vitest"
import type { TickBucket } from "./digest"
import { computeOrderflowRaw, EMPTY_ORDERFLOW } from "./orderflow"

function b(ts: number, o: number, c: number, vol: number, tb: number, cnt = 1, quote?: number): TickBucket {
  return { ts, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, vol, quote: quote ?? vol * c, takerBuyVol: tb, takerBuyQuote: tb * c, count: cnt }
}

describe("computeOrderflowRaw 冻结口径", () => {
  it("空窗口返回冻结默认", () => {
    expect([...computeOrderflowRaw([], 1)]).toEqual([...EMPTY_ORDERFLOW])
  })

  it("SL_OF_IMB = 主动买占比", () => {
    const w = [b(0, 1, 1, 10, 6), b(1, 1, 1, 10, 2)]
    const r = computeOrderflowRaw(w, 1)
    expect(r[0]).toBeCloseTo(8 / 20, 15)
  })

  it("比例类特征量归一不变（scale 无关）", () => {
    const w = [b(0, 1, 1, 10, 6), b(1, 1, 1, 10, 2), b(2, 1, 2, 5, 1)]
    const s1 = computeOrderflowRaw(w, 1)
    const s2 = computeOrderflowRaw(w, 4)
    for (const idx of [0, 1, 3, 4, 5, 6, 7]) {
      expect(s2[idx]).toBe(s1[idx] as number)
    }
    expect(s2[2]).toBeGreaterThan(s1[2] as number) // TRD_INT 随归一 count 增大
  })

  it("SL_PV_DIV 方向翻转计数", () => {
    // 方向序列 +,+,-,+ → 翻转 2 次 / (4-1)
    const w = [b(0, 1, 2, 1, 1), b(1, 1, 2, 1, 1), b(2, 2, 1, 1, 1), b(3, 1, 2, 1, 1)]
    expect(computeOrderflowRaw(w, 1)[3]).toBeCloseTo(2 / 3, 15)
  })

  it("SL_BURST = max/均值，cap 1000", () => {
    const w = [b(0, 1, 1, 1, 1), b(1, 1, 1, 1, 1), b(2, 1, 1, 7, 1)]
    expect(computeOrderflowRaw(w, 1)[5]).toBeCloseTo(7 / 3, 12)
    // cap：1001 桶中一桶独大 → max/mean≈1000 上限
    const extreme = [b(0, 1, 1, 1000, 1000), ...Array.from({ length: 1000 }, (_, i) => b(i + 1, 1, 1, 1e-6, 1e-6))]
    expect(computeOrderflowRaw(extreme, 1)[5]).toBe(1000)
  })

  it("SL_STREAK_SIG 最长同向连击带符号", () => {
    // 主导方向：买,买,卖,买 → 最长连击 2（买）/4
    const w = [b(0, 1, 1, 10, 9), b(1, 1, 1, 10, 9), b(2, 1, 1, 10, 1), b(3, 1, 1, 10, 9)]
    expect(computeOrderflowRaw(w, 1)[6]).toBeCloseTo(2 / 4, 15)
  })

  it("SL_RHYTHM_ENT 均匀分布=1，集中=0", () => {
    const uni = [b(0, 1, 1, 5, 5), b(1, 1, 1, 5, 5)]
    expect(computeOrderflowRaw(uni, 1)[7]).toBeCloseTo(1, 12)
    const conc = [b(0, 1, 1, 10, 10), b(1, 1, 1, 0, 0)]
    expect(computeOrderflowRaw(conc, 1)[7]).toBeCloseTo(0, 12)
  })

  it("SL_VWAP_DEV = close/VWAP − 1", () => {
    const w = [b(0, 100, 100, 2, 1, 1, 200), b(1, 100, 110, 2, 1, 1, 200)]
    // vwap = 400/4 = 100, close = 110 → 0.1
    expect(computeOrderflowRaw(w, 1)[4]).toBeCloseTo(0.1, 12)
  })

  it("确定性：同输入双跑逐位一致", () => {
    const w = Array.from({ length: 30 }, (_, i) => b(i, 100 + (i % 7), 100 + ((i * 3) % 11), 1 + (i % 5), i % 3))
    const a = computeOrderflowRaw(w, 1.7)
    const c = computeOrderflowRaw([...w], 1.7)
    expect([...a]).toEqual([...c])
  })
})
