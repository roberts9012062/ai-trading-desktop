/**
 * 验收门 D3 的早期证据 —— 流式打分引擎与重放器在同一 tick 序列上分数一致
 * （实时=回放；两路径共用 forming-bar/orderflow/evaluator 同一实现）。
 * 页面接线后（M-D3）以同一测试形态复跑。
 */

import { describe, expect, it } from "vitest"
import { BucketAccumulator, type AggTradeEvent } from "./bucket-stream"
import { digestSha256 } from "./digest"
import { LiveScoringEngine } from "./live"
import { replayScores } from "./replay"
import { syntheticAggTradesRounded } from "./synthetic"
import { CADENCE_CHOICES } from "./spec"

function events(seed: number, seconds: number): AggTradeEvent[] {
  return [...syntheticAggTradesRounded({ seed, symbol: "TEST", startTsSec: 1_700_432_000, seconds, tradeEveryAvgSec: 5 })]
}

describe("D3 证据：实时=回放（同一 tick 序列）", () => {
  for (const cadence of [3, 15, 60] as const) {
    it(`cadence=${cadence}s 流式与重放逐位一致`, { timeout: 60_000 }, () => {
      const evs = events(77, 1_800)
      const acc = new BucketAccumulator()
      for (const e of evs) acc.pushEvent(e)
      const buckets = acc.list()
      const champions = [
        { tokens: [0, 64 + 23, 64 + 12] as const },
        { tokens: [115, 64 + 32, 64 + 12] as const },
        { tokens: [5, 6, 64 + 29] as const },
      ]
      const replay = replayScores(buckets, {
        timeframe: "1m", cadence, champions: champions.map((c) => ({ tokens: [...c.tokens] })),
      }, digestSha256(buckets))
      expect(replay.steps.length).toBeGreaterThan(10)

      const live = new LiveScoringEngine({ timeframe: "1m", cadence, champions: champions.map((c) => ({ tokens: [...c.tokens] })) })
      for (const e of evs) live.onAggTrade(e)
      for (const step of replay.steps) {
        const sample = live.onCadence(step.t)
        expect(sample).not.toBeNull()
        if (!sample) continue
        expect(sample.scores.length).toBe(step.scores.length)
        for (let i = 0; i < step.scores.length; i++) {
          const a = step.scores[i]!
          const b = sample.scores[i]!
          if (a === null || b === null) {
            expect(a).toBe(b)
          } else {
            expect(b).toBe(a) // 逐位（含 NaN 约定）
          }
        }
        if (step.combo === null) expect(sample.combo).toBeNull()
        else expect(sample.combo).toBe(step.combo)
      }
    })
  }

  it("重放与流式的空窗/预热一致性：无 closed bar 时流式返回 null", () => {
    const evs = events(88, 120)
    const live = new LiveScoringEngine({ timeframe: "1m", cadence: 3, champions: [{ tokens: [0, 64 + 23] }] })
    for (const e of evs) live.onAggTrade(e)
    // 首个 cadence 网格（bar 未收）→ 无 closed bar → null
    const firstGrid = Math.ceil((1_700_432_000 * 1000 + 3000) / 3000) * 3000
    expect(live.onCadence(firstGrid)).toBeNull()
  })
})

void (void CADENCE_CHOICES)
