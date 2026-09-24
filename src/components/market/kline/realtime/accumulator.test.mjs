/**
 * realtime/accumulator.ts 单测（Node 22 原生 TS 直 import，先例见
 * components/backtest/timeframe-limits.test.mjs）
 *
 * 覆盖：
 *  - offerRtBar：同 bar 多帧高/低水位合并、版本号守卫防乱序回归
 *  - readRtTail：按历史尾键剪枝（< 丢弃、== 保留给 forming 合并）、时间升序
 *  - mergeTailWithHistory：追加 / 与历史末根同时间合并两条路径
 *  - detectTailGap：正常连续无缺口、缺根命中、午休级跳变命中、
 *    隔夜跳变跳过、日线不参与
 *  - 容量上限：单 key bar 数超限丢最旧
 *
 * 跑法：node --test src/components/market/kline/realtime/accumulator.test.mjs
 * （在 frontend 目录下）
 */

import assert from "node:assert/strict"
import test from "node:test"

const {
  offerRtBar,
  offerRtFrames,
  readRtTail,
  clearRtAccumulator,
  rtAccKey,
  mergeTailWithHistory,
  detectTailGap,
} = await import("./accumulator.ts")

const bar = (time, over = {}) => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
  ...over,
})

test("offerRtBar 同 bar 多帧合并高低水位，close 取最新", () => {
  clearRtAccumulator()
  const key = rtAccKey("RB2610", "1m")
  offerRtBar("rb2610", "1m", bar("2026-09-10 09:00:00", { high: 101, low: 99, close: 100 }))
  offerRtBar("rb2610", "1m", bar("2026-09-10 09:00:00", { high: 103, low: 98, close: 102 }))
  const tail = readRtTail(key, "")
  assert.equal(tail.length, 1)
  assert.equal(tail[0].high, 103)
  assert.equal(tail[0].low, 98)
  assert.equal(tail[0].close, 102)
  // open 保留首帧（mergeRealtimeBar 语义）
  assert.equal(tail[0].open, 100)
})

test("offerRtBar 版本号守卫：低版本旧帧不回归已累积状态", () => {
  clearRtAccumulator()
  const key = rtAccKey("rb2610", "1m")
  offerRtBar("rb2610", "1m", bar("2026-09-10 09:00:00", { close: 102, version: 5 }))
  offerRtBar("rb2610", "1m", bar("2026-09-10 09:00:00", { close: 100, version: 3 }))
  const tail = readRtTail(key, "")
  assert.equal(tail[0].close, 102)
})

test("readRtTail 剪枝：早于历史尾键丢弃、等于保留（forming 合并用）", () => {
  clearRtAccumulator()
  const key = rtAccKey("m2701", "5m")
  offerRtBar("m2701", "5m", bar("2026-09-10 09:00:00"))
  offerRtBar("m2701", "5m", bar("2026-09-10 09:05:00"))
  offerRtBar("m2701", "5m", bar("2026-09-10 09:10:00"))
  // 历史已含 09:05（含）之前的已收盘 bar
  const tail = readRtTail(key, "2026-09-10 09:05:00")
  assert.equal(tail.length, 2)
  assert.equal(tail[0].time, "2026-09-10 09:05:00")
  assert.equal(tail[1].time, "2026-09-10 09:10:00")
})

test("readRtTail 乱序到达按时间键升序返回", () => {
  clearRtAccumulator()
  const key = rtAccKey("m2701", "1m")
  offerRtBar("m2701", "1m", bar("2026-09-10 09:03:00"))
  offerRtBar("m2701", "1m", bar("2026-09-10 09:01:00"))
  offerRtBar("m2701", "1m", bar("2026-09-10 09:02:00"))
  const tail = readRtTail(key, "")
  assert.deepEqual(
    tail.map((b) => b.time.slice(11, 16)),
    ["09:01", "09:02", "09:03"],
  )
})

test("offerRtFrames 批量入口跳过残缺项", () => {
  clearRtAccumulator()
  offerRtFrames([
    { symbol: "rb2610", period: "1m", bar: bar("2026-09-10 09:00:00") },
    { symbol: "rb2610", period: "1m" }, // 缺 bar
    null,
    { symbol: "", period: "1m", bar: bar("2026-09-10 09:01:00") }, // 缺 symbol
  ])
  const tail = readRtTail(rtAccKey("rb2610", "1m"), "")
  assert.equal(tail.length, 1)
})

test("mergeTailWithHistory：尾首根与历史末根同时间 → 合入末根", () => {
  const currentBars = [
    bar("2026-09-10 08:55:00", { close: 100, high: 101 }),
    bar("2026-09-10 09:00:00", { close: 100, high: 101 }),
  ]
  const tail = [
    bar("2026-09-10 09:00:00", { close: 105, high: 106, volume: 99 }),
    bar("2026-09-10 09:05:00", { close: 107 }),
  ]
  const built = mergeTailWithHistory(currentBars, tail, "5m")
  assert.ok(built)
  // 末根被合入：高水位、新 close、新 volume
  assert.equal(built.mergedBars.length, 3)
  assert.equal(built.mergedBars[1].high, 106)
  assert.equal(built.mergedBars[1].close, 105)
  assert.equal(built.mergedBars[1].volume, 99)
  assert.equal(built.applyBars.length, 2)
  assert.equal(built.chartBar.time, "2026-09-10 09:05:00")
})

test("mergeTailWithHistory：尾整体晚于历史 → 追加", () => {
  const currentBars = [bar("2026-09-10 09:00:00")]
  const tail = [
    bar("2026-09-10 09:05:00"),
    bar("2026-09-10 09:10:00"),
  ]
  const built = mergeTailWithHistory(currentBars, tail, "5m")
  assert.ok(built)
  assert.equal(built.mergedBars.length, 3)
  assert.equal(built.chartBar.time, "2026-09-10 09:10:00")
  // 空入参
  assert.equal(mergeTailWithHistory(currentBars, [], "5m"), null)
  assert.equal(mergeTailWithHistory([], tail, "5m"), null)
})

test("detectTailGap：1m 正常连续（含容差内）不报缺口", () => {
  const tail = [
    bar("2026-09-10 09:02:00"),
    bar("2026-09-10 09:03:00"),
    bar("2026-09-10 09:05:00"), // 缺 09:04，1 分钟容差内（>2 分钟才报）
  ]
  assert.equal(detectTailGap("1m", "2026-09-10 09:01:00", tail), null)
})

test("detectTailGap：1m 缺 3 分钟 → 命中缺口签名", () => {
  const tail = [bar("2026-09-10 09:05:00")]
  assert.equal(
    detectTailGap("1m", "2026-09-10 09:01:00", tail),
    "2026-09-10 09:01:00=>2026-09-10 09:05:00",
  )
})

test("detectTailGap：午休 15 分钟跳变命中（重拉一次后进历史，不循环）", () => {
  const tail = [bar("2026-09-10 10:30:00")]
  assert.equal(
    detectTailGap("1m", "2026-09-10 10:15:00", tail),
    "2026-09-10 10:15:00=>2026-09-10 10:30:00",
  )
})

test("detectTailGap：隔夜/跨段大跳变不报（<=6 小时才算缺口）", () => {
  const tail = [bar("2026-09-11 09:00:00")]
  assert.equal(detectTailGap("1m", "2026-09-10 23:00:00", tail), null)
})

test("detectTailGap：日线与空输入不参与", () => {
  assert.equal(detectTailGap("1d", "2026-09-09", [bar("2026-09-16")]), null)
  assert.equal(detectTailGap("1m", "2026-09-10 09:00:00", []), null)
  assert.equal(detectTailGap("1m", "", [bar("2026-09-10 09:05:00")]), null)
})

test("detectTailGap：60m 周期缺口判定按周期倍数", () => {
  // 10:00 → 13:00（3 小时 > 2×60m 且 <= 6h）命中
  assert.equal(
    detectTailGap("60m", "2026-09-10 10:00:00", [bar("2026-09-10 13:00:00")]),
    "2026-09-10 10:00:00=>2026-09-10 13:00:00",
  )
  // 10:00 → 11:00 连续不报
  assert.equal(
    detectTailGap("60m", "2026-09-10 10:00:00", [bar("2026-09-10 11:00:00")]),
    null,
  )
})

test("容量上限：单 key 超限丢最旧（保住最新 forming 附近）", () => {
  clearRtAccumulator()
  const key = rtAccKey("rb2610", "1m")
  // 直接压 481 根不同分钟，触发 480 上限
  const base = Date.parse("2026-09-10T09:00:00Z")
  for (let i = 0; i < 481; i++) {
    const t = new Date(base + i * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19)
    offerRtBar("rb2610", "1m", bar(t))
  }
  const tail = readRtTail(key, "")
  assert.equal(tail.length, 480)
  // 最旧一根（09:00）被淘汰
  assert.notEqual(tail[0].time, "2026-09-10 09:00:00")
})
