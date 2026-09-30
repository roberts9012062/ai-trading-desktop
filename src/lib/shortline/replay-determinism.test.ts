/**
 * 验收门 D1 —— tick 重放验证器双跑逐位一致。
 *
 * 多数据集（3 个种子）× 全部 cadence 档位 × 多公式（含 v4 token 与二元算子）：
 * 两个完全独立的重放实例，输出分数序列的 f64 位模式必须完全一致。
 * 同时验证 digest 序列化 roundtrip 后重放仍逐位一致（冻结数据集协议）。
 */

import { describe, expect, it } from "vitest"
import { BucketAccumulator } from "./bucket-stream"
import { decodeDigest, digestSha256, encodeDigest } from "./digest"
import { replayBits, replayScores, type ReplayOptions } from "./replay"
import { syntheticAggTradesRounded } from "./synthetic"
import { CADENCE_CHOICES } from "./spec"

function buildBuckets(seed: number, startSec: number, seconds: number, everySec = 6): ReturnType<() => readonly ReturnType<BucketAccumulator["list"]>[number][]> {
  const acc = new BucketAccumulator()
  for (const e of syntheticAggTradesRounded({ seed, symbol: "TEST", startTsSec: startSec, seconds, tradeEveryAvgSec: everySec })) {
    acc.pushEvent(e)
  }
  return acc.list()
}

// 公式集合：base 特征、v4 特征、二元算子、深窗算子（与挖掘 token 编码同构）
const FORMULAS: ReadonlyArray<readonly number[]> = [
  [0, 64 + 23, 64 + 12],            // RET → TS_ZSCORE_20 → TANH
  [115, 64 + 32, 64 + 12],          // SL_OF_IMB → TS_ZSCORE_60 → TANH
  [5, 6, 64 + 29],                  // ATR14, RVOL → CORR_20
  [115, 116, 64 + 0, 64 + 46],      // OF_IMB, BIG_SHARE → ADD → VOL_SCALE_20
  [37, 64 + 15, 8, 64 + 35],        // VWAP_DEV→MA20, DEV → BETA_20
  [24, 0, 64 + 3, 64 + 44],         // RET60, RET → DIV → ROBUST_ZSCORE_20
]

const DATASETS = [
  { seed: 11, startSec: 1_700_000_000, seconds: 2_400, everySec: 5, timeframe: "1m" as const },
  { seed: 22, startSec: 1_700_086_400, seconds: 3_600, everySec: 8, timeframe: "1m" as const },
  { seed: 33, startSec: 1_700_172_800, seconds: 7_200, everySec: 10, timeframe: "5m" as const },
]

describe("D1 门：重放器双跑逐位一致", () => {
  for (const ds of DATASETS) {
    it(`dataset seed=${ds.seed} tf=${ds.timeframe} 全 cadence 双跑一致`, { timeout: 120_000 }, () => {
      const buckets = buildBuckets(ds.seed, ds.startSec, ds.seconds, ds.everySec)
      expect(buckets.length).toBeGreaterThan(50)
      const sha = digestSha256(buckets)
      for (const cadence of CADENCE_CHOICES) {
        const opts: ReplayOptions = {
          timeframe: ds.timeframe,
          cadence,
          champions: FORMULAS.map((tokens) => ({ tokens })),
        }
        const run1 = replayScores(buckets, opts, sha)
        const run2 = replayScores(buckets, opts, sha)
        // 步数非平凡
        expect(run1.steps.length).toBeGreaterThan(10)
        // 双跑逐位一致（D1 核心）
        expect(replayBits(run1)).toBe(replayBits(run2))
        // 组合分与冠军分自洽
        for (const step of run1.steps) {
          if (step.combo !== null) {
            expect(Number.isFinite(step.combo)).toBe(true)
            expect(Math.abs(step.combo)).toBeLessThanOrEqual(1 + 1e-12)
          }
        }
      }
    })
  }

  it("digest 序列化 roundtrip 后重放仍逐位一致（冻结数据集协议）", { timeout: 60_000 }, () => {
    const buckets = buildBuckets(44, 1_700_259_200, 1_800, 6)
    const sha = digestSha256(buckets)
    const restored = decodeDigest(encodeDigest(buckets))
    const opts: ReplayOptions = {
      timeframe: "1m", cadence: 5,
      champions: FORMULAS.slice(0, 4).map((tokens) => ({ tokens })),
    }
    const a = replayBits(replayScores(buckets, opts, sha))
    const b = replayBits(replayScores(restored, opts, sha))
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(100)
  })

  it("不同 cadence 输出不同指纹（网格确实生效）", () => {
    const buckets = buildBuckets(55, 1_700_345_600, 1_800, 6)
    const sha = digestSha256(buckets)
    const mk = (cadence: 3 | 15) => replayBits(replayScores(buckets, {
      timeframe: "1m", cadence, champions: [{ tokens: [0, 64 + 23, 64 + 12] }],
    }, sha))
    expect(mk(3)).not.toBe(mk(15))
  })
})
