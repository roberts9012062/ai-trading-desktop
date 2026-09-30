import { describe, expect, it } from "vitest"
import { BucketAccumulator } from "./bucket-stream"
import { digestSha256 } from "./digest"
import { qualifyShortline, spearman, SHORTLINE_GATE } from "./gate"
import { closedBarsFromDigest, replayScores } from "./replay"
import { syntheticAggTradesRounded } from "./synthetic"

function build(seed: number, seconds: number, everySec = 5) {
  const acc = new BucketAccumulator()
  for (const e of syntheticAggTradesRounded({ seed, symbol: "T", startTsSec: 1_700_500_800, seconds, tradeEveryAvgSec: everySec })) {
    acc.pushEvent(e)
  }
  return acc.list()
}

describe("spearman", () => {
  it("完全单调 → 1，反单调 → −1，并列取平均秩（有限值）", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12)
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 12)
    expect(Number.isFinite(spearman([1, 1, 2], [1, 2, 3]))).toBe(true)
    expect(spearman([5, 5, 5], [1, 2, 3])).toBe(0)
  })
})

describe("shortline_v1 合格门", () => {
  it("合成数据上产出门指标且可判定（通过/拒绝皆合法）", () => {
    const buckets = build(21, 7200, 4)
    const champions = [{ tokens: [0, 64 + 23, 64 + 12] }]
    const replay = replayScores(buckets, { timeframe: "1m", cadence: 5, champions }, digestSha256(buckets))
    expect(replay.steps.length).toBeGreaterThan(50)
    const bars = closedBarsFromDigest(buckets, "1m", replay.steps[0]!.barStart, replay.steps[replay.steps.length - 1]!.barStart + 60_000)
    const closes = bars.map((b) => b.close)
    const verdict = qualifyShortline({
      tokens: champions[0]!.tokens,
      replay,
      barCloses: closes,
      oosStartBarIndex: Math.floor(bars.length * 0.7),
    })
    expect(typeof verdict.passed).toBe("boolean")
    expect(verdict.metrics.steps).toBe(replay.steps.length)
    // 门指标有限
    expect(Number.isFinite(verdict.metrics.flip_per_bar)).toBe(true)
    expect(Number.isFinite(verdict.metrics.stability_median)).toBe(true)
    // 拒绝原因可解析（若未通过）
    for (const r of verdict.reasons) expect(typeof r).toBe("string")
  })

  it("非 live 特征被拒（feature_not_live）", () => {
    const buckets = build(22, 1800, 5)
    const tokens = [14, 64 + 23] // OI_CHG(非 live)
    const replay = replayScores(buckets, { timeframe: "1m", cadence: 5, champions: [{ tokens }] }, digestSha256(buckets))
    const verdict = qualifyShortline({
      tokens, replay, barCloses: [100, 101, 102], oosStartBarIndex: 0,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons.some((r) => r.startsWith("feature_not_live"))).toBe(true)
  })

  it("高翻转分数流触发 flip_rate 拒因", () => {
    // 构造交替分数流:手动造 steps
    const mk = (scores: number[]) => ({
      steps: scores.map((s, i) => ({
        t: i * 5000, scores: [s] as Array<number | null>, combo: s,
        barStart: Math.floor((i * 5000) / 60000) * 60000, elapsedSec: 5,
      })),
      digestSha: "x",
      options: { timeframe: "1m" as const, cadence: 5 as const, champions: [{ tokens: [0] }] },
    })
    const alternating = Array.from({ length: 240 }, (_, i) => (i % 2 ? 0.5 : -0.5))
    const verdict = qualifyShortline({
      tokens: [0],
      replay: mk(alternating),
      barCloses: Array.from({ length: 40 }, (_, i) => 100 + i),
      oosStartBarIndex: 0,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.reasons.some((r) => r.startsWith("flip_rate"))).toBe(true)
    expect(verdict.metrics.flip_per_bar).toBeGreaterThan(SHORTLINE_GATE.flipPerBarCap)
  })
})
