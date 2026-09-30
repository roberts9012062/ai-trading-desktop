import { describe, expect, it } from "vitest"
import { binaryMap, delta, divKeepSign, ema, lag, quantile, robustZscore, rollingWinsor, snr, tsCenteredRank, tsCorr, tsMean, tsRank, tsStd, tsZscore, volScale } from "./ops"

const arr = (xs: number[]) => Float64Array.from(xs)

describe("ops 镜像语义", () => {
  it("tsMean 头部部分窗口", () => {
    expect([...tsMean(arr([1, 2, 3, 4]), 2)]).toEqual([1, 1.5, 2.5, 3.5])
    expect([...tsMean(arr([5]), 3)]).toEqual([5])
  })

  it("tsStd 非负", () => {
    const s = tsStd(arr([1, 2, 3, 4, 5, 6]), 3)
    for (const v of s) expect(v).toBeGreaterThanOrEqual(0)
    expect(s[2]!).toBeCloseTo(Math.sqrt(2 / 3), 12)
  })

  it("tsRank 分位（含并列计 ≤）", () => {
    const r = tsRank(arr([3, 1, 2]), 3)
    expect(r[0]!).toBe(1) // 3: 窗 [3]，≤3 计 1 → 1
    expect(r[1]!).toBeCloseTo(0.5, 12) // 窗 [3,1]，≤1 计 1 → 1/2
    expect(r[2]!).toBeCloseTo(2 / 3, 12) // 窗 [3,1,2]，≤2 计 2 → 2/3
  })

  it("delta 前置 0", () => {
    expect([...delta(arr([1, 2, 4, 7]), 2)]).toEqual([0, 0, 3, 5])
    expect([...lag(arr([1, 2, 3]), 1)]).toEqual([0, 1, 2])
  })

  it("divKeepSign 保号除法", () => {
    expect(divKeepSign(1, -2)).toBeCloseTo(-0.5, 15)
    expect(divKeepSign(1, 0)).toBeCloseTo(1e8 * Math.sign(1e-12), 0)
  })

  it("tsCorr 常数列 → 0", () => {
    const c = tsCorr(arr([1, 1, 1, 1]), arr([1, 2, 3, 4]), 3)
    expect(c.every((v) => v === 0)).toBe(true)
    const p = tsCorr(arr([1, 2, 3, 4]), arr([2, 4, 6, 8]), 4)
    expect(p[3]!).toBeCloseTo(1, 12)
  })

  it("tsCenteredRank 并列居中", () => {
    const r = tsCenteredRank(arr([1, 2, 2]), 3)
    // 末值 2：less=1（1），tie=2（两个 2）→ (1+1)*2/3-1 = 1/3
    expect(r[2]!).toBeCloseTo(1 / 3, 12)
  })

  it("ema 递推", () => {
    const e = ema(arr([1, 1, 1]), 2)
    const a = 2 / 3
    expect(e[0]!).toBeCloseTo(a, 15)
    expect(e[1]!).toBeCloseTo(a + (1 - a) * a, 15)
  })

  it("robustZscore 常数输入 → 0", () => {
    const r = robustZscore(arr([5, 5, 5, 5]), 3)
    expect(r.every((v) => v === 0)).toBe(true)
  })

  it("rollingWinsor 头部不裁剪，历史分位裁剪当前值", () => {
    const x = arr([1, 2, 3, 100])
    const w = rollingWinsor(x, 20)
    expect(w[0]!).toBe(1)
    expect(w[1]!).toBe(2)
    // i=3: hist=[1,2,3]，q95 在小样本上=3 附近 → 100 被压
    expect(w[3]!).toBeLessThan(100)
  })

  it("quantile 线性插值", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 15)
    expect(quantile([1, 2, 3, 4], 0)).toBe(1)
    expect(quantile([1, 2, 3, 4], 1)).toBe(4)
  })

  it("volScale / snr / zscore 有界合理", () => {
    const x = arr([1, 2, 3, 4, 5])
    const v = volScale(x, 3)
    expect(Number.isFinite(v[4]!)).toBe(true)
    const s = snr(x, 3)
    expect(s[4]!).toBeGreaterThan(0)
    const z = tsZscore(x, 3)
    expect(Math.abs(z[4]!)).toBeLessThan(3)
  })

  it("binaryMap 长度对齐", () => {
    const out = binaryMap(arr([1, 2]), arr([3, 4]), (a, b) => a * b)
    expect([...out]).toEqual([3, 8])
  })
})
