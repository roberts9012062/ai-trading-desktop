/**
 * timeframe-limits.ts 多段回测常量与区间校验测试
 *
 * 本文件为纯 JS（.mjs），通过 Node 22 原生 TS 支持直接 import ./timeframe-limits.ts。
 * 重点验证：
 *  - multiSegmentMinDays：最小区间 = 段数 × 周期上限（15m 3 段 → 90 天）
 *  - validateBacktestRange：多段最小天数（含首尾口径）/ 单段最大天数互不干扰
 *  - 日线多段拦截
 */

import assert from "node:assert/strict"
import test from "node:test"

const {
  SEGMENT_MIN_COUNT,
  SEGMENT_MAX_COUNT,
  multiSegmentMinDays,
  inclusiveDays,
  validateBacktestRange,
} = await import("./timeframe-limits.ts")

test("segment count bounds match backend (2~5)", () => {
  assert.equal(SEGMENT_MIN_COUNT, 2)
  assert.equal(SEGMENT_MAX_COUNT, 5)
})

test("multiSegmentMinDays = segments × per-timeframe cap", () => {
  // 15m 3 段 → 3×30 = 90 天（产品示例）
  assert.equal(multiSegmentMinDays("15m", 3), 90)
  assert.equal(multiSegmentMinDays("15m", 2), 60)
  assert.equal(multiSegmentMinDays("15m", 5), 150)
  assert.equal(multiSegmentMinDays("1m", 5), 15)
  assert.equal(multiSegmentMinDays("60m", 2), 180)
})

test("inclusiveDays counts both endpoints", () => {
  assert.equal(inclusiveDays("2026-05-01", "2026-05-30"), 30)
  assert.equal(inclusiveDays("2026-05-01", "2026-05-01"), 1)
  // 2026-05-01 ~ 2026-07-29 = 90 天（含首尾）
  assert.equal(inclusiveDays("2026-05-01", "2026-07-29"), 90)
})

test("multi-segment range must be at least segments × cap (inclusive days)", () => {
  // 89 天（含首尾）→ 报错并带最小天数文案
  const short = validateBacktestRange({
    startDate: "2026-05-01",
    endDate: "2026-07-28",
    timeframe: "15m",
    multiSegment: true,
    segmentCount: 3,
  })
  assert.ok(short && short.includes("至少 90 天"), `unexpected: ${short}`)

  // 恰好 90 天（含首尾）→ 通过
  const exact = validateBacktestRange({
    startDate: "2026-05-01",
    endDate: "2026-07-29",
    timeframe: "15m",
    multiSegment: true,
    segmentCount: 3,
  })
  assert.equal(exact, null)

  // 多段无上限：400 天也通过
  const long = validateBacktestRange({
    startDate: "2025-06-01",
    endDate: "2026-07-05",
    timeframe: "15m",
    multiSegment: true,
    segmentCount: 3,
  })
  assert.equal(long, null)
})

test("single-segment max-days rule unchanged", () => {
  // 15m 400 天在单段模式下仍报「最多 30 天」
  const err = validateBacktestRange({
    startDate: "2025-06-01",
    endDate: "2026-07-05",
    timeframe: "15m",
  })
  assert.ok(err && err.includes("最多 30 天"), `unexpected: ${err}`)

  const ok = validateBacktestRange({
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    timeframe: "15m",
  })
  assert.equal(ok, null)
})

test("daily timeframe rejects multi-segment", () => {
  const err = validateBacktestRange({
    startDate: "2024-01-01",
    endDate: "2026-01-01",
    timeframe: "1d",
    multiSegment: true,
    segmentCount: 2,
  })
  assert.ok(err && err.includes("日线不支持多段回测"), `unexpected: ${err}`)
})

test("end before start is rejected in both modes", () => {
  assert.ok(
    validateBacktestRange({
      startDate: "2026-06-02",
      endDate: "2026-06-01",
      timeframe: "15m",
    }),
  )
  assert.ok(
    validateBacktestRange({
      startDate: "2026-06-02",
      endDate: "2026-06-01",
      timeframe: "15m",
      multiSegment: true,
      segmentCount: 2,
    }),
  )
})
