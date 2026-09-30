import { describe, expect, it } from "vitest"
import { BucketAccumulator } from "./bucket-stream"
import { digestSha256 } from "./digest"
import { buildFixtureBundle, buildGoldenCase } from "./fixtures"
import { buildShortlinePayload, checkMountable, requiredWarmupBars } from "./mount"
import { syntheticAggTradesRounded } from "./synthetic"

function buckets(seed: number, seconds: number) {
  const acc = new BucketAccumulator()
  for (const e of syntheticAggTradesRounded({ seed, symbol: "ETHUSDT", startTsSec: 1_700_600_000, seconds, tradeEveryAvgSec: 6 })) {
    acc.pushEvent(e)
  }
  return acc.list()
}

const FORMULAS: ReadonlyArray<readonly number[]> = [
  [0, 64 + 23, 64 + 12],
  [5, 6, 64 + 29],
]

describe("挂载载荷组装（契约 shortline_factor_v1）", () => {
  it("schema 字段与契约逐字段一致", () => {
    const payload = buildShortlinePayload(
      {
        symbol: "ETHUSDT", timeframe: "15m", cadence: 15,
        champions: [{ id: 1, tokens: FORMULAS[0]! }, { id: 2, tokens: FORMULAS[1]! }],
        weights: [0.7, 0.3],
      },
      "a".repeat(64),
    )
    expect(Object.keys(payload).sort()).toEqual([
      "cadence_seconds", "champions", "decision", "eval_version", "fixture_manifest",
      "risk", "symbol", "task_type", "timeframe", "warmup_bars",
    ])
    expect(payload.task_type).toBe("shortline_factor_v1")
    expect(payload.eval_version).toBe("shortline-eval-v1")
    expect(payload.decision).toEqual({ threshold: 0.25, confirm_steps: 3, max_actions_per_hour: 6, max_actions_per_bar: 1, stale_multiplier: 2 })
    expect(payload.risk).toEqual({ max_notional_usdt: 1000, daily_loss_limit_usdt: 50, mode: "paper" })
    expect(payload.fixture_manifest).toBe(`sha256:${"a".repeat(64)}`)
    // 权重归一
    const w = payload.champions.map((c) => c.weight)
    expect(w[0]! + w[1]!).toBeCloseTo(1, 12)
    expect(w[0]!).toBeCloseTo(0.7, 9)
  })

  it("v4/服务器缺失特征拒绝挂载并给原因", () => {
    const withV4 = checkMountable([[115, 64 + 23]])
    expect(withV4.ok).toBe(false)
    expect(withV4.localOnlyTokens).toEqual([115])
    const withMissing = checkMountable([[55]])
    expect(withMissing.ok).toBe(false)
    expect(checkMountable([[0, 64 + 23]]).ok).toBe(true)
    // 载荷组装对不可挂载直接抛错
    expect(() => buildShortlinePayload(
      { symbol: "ETHUSDT", timeframe: "15m", cadence: 15, champions: [{ id: 1, tokens: [115] }] },
      "0".repeat(64),
    )).toThrow()
  })

  it("warmup 下限 300 且随深窗算子抬升", () => {
    const base = requiredWarmupBars([[0, 64 + 23]], "15m")
    expect(base).toBeGreaterThanOrEqual(300)
    const deep = requiredWarmupBars([[0, 64 + 49]], "1m") // TS_ZSCORE_120 + 1m 大窗
    expect(deep).toBeGreaterThan(base)
  })
})

describe("黄金夹具导出（服务器 S1 门依赖）", () => {
  it("夹具自校验 + manifest SHA 确定性", { timeout: 60_000 }, () => {
    const bs = buckets(31, 1800)
    const mk = () => buildGoldenCase({
      name: "case-a", symbol: "ETHUSDT", timeframe: "1m", cadence: 5,
      buckets: bs, formulas: FORMULAS,
    })
    const c1 = mk()
    const c2 = mk()
    // 同输入 → 逐位一致的期望序列与 digest SHA
    expect(JSON.stringify(c1.expected)).toBe(JSON.stringify(c2.expected))
    expect(c1.digest_sha256).toBe(digestSha256(bs.slice(Math.max(0, bs.length - 3600))))
    // 步数非平凡且位模式为 16 位 hex
    expect(c1.expected.steps.length).toBeGreaterThan(10)
    expect(c1.expected.steps[0]!.scores[0]!).toMatch(/^[0-9a-f]{16}$|^null$|^nan$/)

    const b1 = buildFixtureBundle("ETHUSDT", [c1], FORMULAS)
    const b2 = buildFixtureBundle("ETHUSDT", [mk()], FORMULAS)
    expect(b1.manifest.manifest_sha256).toBe(b2.manifest.manifest_sha256)
    expect(b1.fixture.libm_sensitive_ops).toContain("TANH")
    expect(b1.fixture.forming_bar_spec).toBe("forming-bar-spec/1")
  })
})
