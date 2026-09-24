/**
 * screener-api.ts 纯函数测试
 *
 * 验证条件默认值、摘要文案与 window 生效范围的前端逻辑。
 * 通过 Node 22 原生 TS 支持直接 import ./screener-api.ts。
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  COND_TYPE_META,
  SCREENER_PERIODS,
  applyChartDefaults,
  conditionSummary,
  makeCondition,
  normalizeCondition,
  opUsesWindow,
} from "./screener-api.ts"

test("六个指标类型均有中文名与操作列表", () => {
  const types = ["pivot", "macd", "ma", "kdj", "rsi", "boll"]
  for (const t of types) {
    const meta = COND_TYPE_META[t]
    assert.ok(meta.name.length > 0)
    assert.ok(meta.ops.length >= 2)
  }
})

test("周期覆盖 5 分钟到日线", () => {
  assert.deepEqual(
    SCREENER_PERIODS.map((p) => p.value),
    ["5m", "15m", "30m", "60m", "1d"],
  )
})

test("makeCondition 默认参数对齐图表指标", () => {
  const macd = makeCondition("macd")
  assert.equal(macd.fast, 12)
  assert.equal(macd.slow, 26)
  assert.equal(macd.signal, 9)
  assert.equal(macd.window, 1)

  const ma = makeCondition("ma")
  assert.deepEqual(
    [ma.ma_short, ma.ma_mid, ma.ma_long],
    [5, 10, 20],
  )

  const rsi = makeCondition("rsi")
  assert.equal(rsi.period, 14)
  assert.equal(rsi.overbought, 70)
  assert.equal(rsi.oversold, 30)

  const boll = makeCondition("boll")
  assert.equal(boll.period, 20)
  assert.equal(boll.std, 2)

  // 每个条件 id 唯一（可重复添加同类型条件做组合）
  const a = makeCondition("kdj")
  const b = makeCondition("kdj")
  assert.notEqual(a.id, b.id)
})

test("opUsesWindow：事件类用窗口，状态类不用", () => {
  assert.equal(opUsesWindow({ type: "pivot", op: "" }), true)
  assert.equal(opUsesWindow({ type: "macd", op: "golden" }), true)
  assert.equal(opUsesWindow({ type: "macd", op: "dif_above" }), false)
  assert.equal(opUsesWindow({ type: "ma", op: "bull_arrange" }), false)
  assert.equal(opUsesWindow({ type: "ma", op: "cross_above" }), true)
  assert.equal(opUsesWindow({ type: "kdj", op: "overbought" }), false)
  assert.equal(opUsesWindow({ type: "rsi", op: "cross_up_50" }), true)
  assert.equal(opUsesWindow({ type: "boll", op: "above_middle" }), false)
})

test("conditionSummary 输出可读摘要", () => {
  assert.match(conditionSummary(makeCondition("macd")), /MACD · 金叉\(12,26,9\)/)
  assert.match(conditionSummary(makeCondition("ma")), /均线 · 多头排列\(MA5\/10\/20\)/)
  const pivot = makeCondition("pivot")
  assert.match(conditionSummary(pivot), /波段 · 做多信号/)
})

test("makeCondition pivot 含分型与 ATR 参数", () => {
  const pivot = makeCondition("pivot")
  assert.deepEqual(
    [pivot.left, pivot.right, pivot.atr_period],
    [3, 3, 14],
  )
})

test("applyChartDefaults 用图表设置覆盖默认参数", () => {
  const cond = applyChartDefaults(makeCondition("pivot"), {
    pivot: { left: 5, right: 2, atrPeriod: 20, minAmplitudePct: 2.5, minAtrMult: 1 },
  })
  assert.equal(cond.left, 5)
  assert.equal(cond.right, 2)
  assert.equal(cond.atr_period, 20)
  assert.equal(cond.min_amplitude_pct, 2.5)
  assert.equal(cond.min_atr_mult, 1)

  const macd = applyChartDefaults(makeCondition("macd"), {
    macd: { fastPeriod: 6, slowPeriod: 13, signalPeriod: 5 },
  })
  assert.deepEqual([macd.fast, macd.slow, macd.signal], [6, 13, 5])

  // 无对应配置时保持默认
  const untouched = applyChartDefaults(makeCondition("macd"), null)
  assert.deepEqual([untouched.fast, untouched.slow, untouched.signal], [12, 26, 9])
})

test("normalizeCondition 补齐旧版本缺失字段", () => {
  const legacy = {
    id: "pivot-1",
    type: "pivot",
    side: "long",
    window: 3,
    // 旧版本没有 left/right/atr_period
  }
  const norm = normalizeCondition(legacy)
  assert.equal(norm.id, "pivot-1")
  assert.equal(norm.window, 3)
  assert.equal(norm.left, 3)
  assert.equal(norm.right, 3)
  assert.equal(norm.atr_period, 14)

  // 非法类型回退默认
  assert.equal(normalizeCondition({ type: "nope" }).type, "pivot")
})
