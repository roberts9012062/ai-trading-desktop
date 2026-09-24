/**
 * strength-v2 V2 形态档规格断言（互斥 / 滞回 / 六档触发与不触发 / ATR 边界）
 *
 * 与 strength-v2.test.mjs 分工：那边证 fixture 逐位对齐与通用性质，
 * 这边逐条守护 V2 设计文档 4.2-4.6 / 8.1 的行为语义。
 * 辅助函数从 strength-v2.test.mjs 复用（caseBars / caseParams / s2Closes / CASE）。
 *
 * 跑法：node --test src/lib/strength-v2-spec.test.mjs（在 frontend 目录下）
 */

import assert from "node:assert/strict"
import test from "node:test"

import { calcStrengthV2, DEFAULT_STRENGTH_V2_PARAMS } from "./strength-v2.ts"
import { CASE, caseBars, caseParams, s2Closes } from "./strength-v2.test.mjs"

// —— 互斥性（4.5 四条论证，逐条断言）——

test("互斥 1/2 vs 5/6：翻转档与衰竭档的 regime 口径（方案一：衰竭须在段内）", () => {
  for (const c of Object.values(CASE)) {
    const first = caseParams(c).period - 1
    for (const s of c.expected_signals) {
      const k = s.index - first
      const r = c.expected_regimes[k]
      if (s.kind === "rebound") assert.equal(r, "up", `${c.name} rebound@${s.index} regime 应为 up`)
      if (s.kind === "breakdown") assert.equal(r, "down", `${c.name} breakdown@${s.index} regime 应为 down`)
      if (s.kind === "bottom_exhaust") assert.equal(r, "down", `${c.name} bottom_exhaust@${s.index} regime 应为 down（段内相对位置）`)
      if (s.kind === "top_exhaust") assert.equal(r, "up", `${c.name} top_exhaust@${s.index} regime 应为 up（段内相对位置）`)
    }
  }
})

test("互斥 3/4 与 5/6：turnUp/turnDown 符号相反，不可能同根", () => {
  // 用输出点（保留 2 位）差分；衰竭档的 d 可能极小、舍入后为 0，
  // 故衰竭档只断言非反向（d ≥ 0 / d ≤ 0），中继档差分大、断言严格符号
  for (const c of Object.values(CASE)) {
    const closes = s2Closes(c)
    for (const s of c.expected_signals) {
      const k = s.index - (caseParams(c).period - 1)
      const d = closes[k] - closes[k - 1]
      if (s.kind === "continuation_long") assert.ok(d > 0, `${c.name} ${s.kind}@${s.index} 应为转向向上`)
      if (s.kind === "continuation_short") assert.ok(d < 0, `${c.name} ${s.kind}@${s.index} 应为转向向下`)
      if (s.kind === "bottom_exhaust") assert.ok(d >= 0, `${c.name} ${s.kind}@${s.index} 不得为转向向下`)
      if (s.kind === "top_exhaust") assert.ok(d <= 0, `${c.name} ${s.kind}@${s.index} 不得为转向向上`)
    }
  }
})

test("互斥 3 vs 5 与 1 vs 3：中继档 regime 同前根，翻转档 regime 恰变化", () => {
  for (const c of Object.values(CASE)) {
    const first = caseParams(c).period - 1
    for (const s of c.expected_signals) {
      const k = s.index - first
      if (s.kind === "rebound" || s.kind === "breakdown") {
        assert.notEqual(c.expected_regimes[k], c.expected_regimes[k - 1], `${c.name} ${s.kind}@${s.index} 应为翻转根`)
      }
      if (s.kind.startsWith("continuation_")) {
        assert.equal(c.expected_regimes[k], c.expected_regimes[k - 1], `${c.name} ${s.kind}@${s.index} 应为非翻转根`)
      }
    }
  }
})

// —— 各形态档的触发与不触发（8.1 用例行为断言）——

test("滞回带：hysteresis_hold 的 S 全程徘徊带内，regime 恒 none、零信号", () => {
  const c = CASE.hysteresis_hold
  assert.equal(c.expected_signals.length, 0)
  assert.ok(c.expected_regimes.every((r) => r === "none"))
  for (const p of c.expected_points) {
    assert.ok(p.close > 45 && p.close < 55, `S=${p.close} 越出滞回带`)
  }
})

test("regime 初始化静默：none→up 不出 rebound，首个信号在真正的 up→down 翻转", () => {
  const c = CASE.regime_init_silent
  const first = caseParams(c).period - 1
  assert.equal(c.expected_regimes[0], "up", "开局上行应初始化为 up")
  assert.ok(!c.expected_signals.some((s) => s.index === first), "初始化根不得出信号")
  assert.deepEqual(
    c.expected_signals.map((s) => s.kind),
    ["breakdown", "bottom_exhaust", "rebound"],
  )
})

// 区分 >= 与 > 的强守护，不得弱化或删除：翻转根深下影低点（108.5）须远低于
// 其后回调低点（109.4），锤头候选根下影（107.6）落在两阈值之间 —— >= 写法
// pullbackLowBefore=109.4 拒绝；> 写法翻转根低点滞留 pullback（108.5）会放行
// continuation_long@24，fixture 对齐必挂（已用变体内核实测验证）
test("翻转后中继陷阱：flip_bar_not_pullback 翻转根出 rebound，其后锤头转红柱被价格确认拒绝", () => {
  const c = CASE.flip_bar_not_pullback
  assert.equal(c.expected_signals.length, 1, "整条序列只应出翻转信号")
  assert.equal(c.expected_signals[0].kind, "rebound")
  assert.equal(c.expected_signals[0].index, 20)
  // i=24 为锤头转红柱：S2 拐头向上（d>0 且 dPrev≤0）但下影刺破回调低点 → 不得出任何信号
  const closes = s2Closes(c)
  const k = 24 - (caseParams(c).period - 1)
  const d = closes[k] - closes[k - 1]
  const dPrev = closes[k - 1] - closes[k - 2]
  assert.ok(d > 0 && dPrev <= 0, "i=24 应为 turnUp 根（断言有效性前提）")
  assert.ok(!c.expected_signals.some((s) => s.index === 24), "拒绝根不得出信号")
})

test("优先级：priority_flip 翻转根同时满足 turnUp，只出 rebound 不出中继", () => {
  const c = CASE.priority_flip
  const byIndex = Object.fromEntries(c.expected_signals.map((s) => [s.index, s.kind]))
  assert.equal(byIndex[23], "rebound", "翻转根应为 rebound")
  assert.ok(!c.expected_signals.some((s) => s.index === 23 && s.kind !== "rebound"))
  const closes = s2Closes(c)
  const k = 23 - (caseParams(c).period - 1)
  assert.ok(closes[k] - closes[k - 1] > 0 && closes[k - 1] - closes[k - 2] <= 0, "翻转根 turnUp 条件应同时成立")
})

test("价格确认拒绝：reject 根 turnUp 成立但创回调新低 → 不触发；随后守住低点 → 触发", () => {
  const c = CASE.continuation_price_reject
  const byIndex = Object.fromEntries(c.expected_signals.map((s) => [s.index, s.kind]))
  assert.equal(byIndex[19], undefined, "i=19 turnUp 创回调新低，不得出中继")
  assert.equal(byIndex[21], "continuation_long", "i=21 低点守住应出中继")
})

test("无回调不出中继：no_pullback 翻转后 S 一路创新高，中继永不触发", () => {
  const c = CASE.no_pullback
  assert.ok(!c.expected_signals.some((s) => s.kind.startsWith("continuation_")))
  assert.deepEqual(c.expected_signals.map((s) => s.kind), ["rebound"])
})

test("ATR 预热不降级：atr_warmup 预热段 turnUp 不出中继，ATR 生效后正常触发", () => {
  const c = CASE.atr_warmup
  const params = caseParams(c)
  const closes = s2Closes(c)
  const first = params.period - 1
  // 预热段（i < atrPeriod=26）确实存在满足 turnUp 的根（断言有效性前提）
  let warmupTurnUp = false
  for (let k = 2; k < closes.length; k++) {
    const i = first + k
    if (i < params.atrPeriod && closes[k] - closes[k - 1] > 0 && closes[k - 1] - closes[k - 2] <= 0) {
      warmupTurnUp = true
    }
  }
  assert.ok(warmupTurnUp, "预热段应存在 turnUp 根")
  assert.ok(!c.expected_signals.some((s) => s.index < params.atrPeriod), "预热段不得出任何信号")
  // top_exhaust@26 恰在 ATR 生效边界（i == atrPeriod）触发，顺带证明衰竭档同受 ATR 门控
  assert.deepEqual(c.expected_signals.map((s) => s.kind), ["top_exhaust", "continuation_long"])
})

test("底部衰竭两路：flat 用例窗内柱体全部 ≤ flatEps 且收缩比不成立；shrink 用例反之", () => {
  const flat = CASE.bottom_exhaust_flat
  const shrink = CASE.bottom_exhaust_shrink
  const eps = DEFAULT_STRENGTH_V2_PARAMS.flatEps
  const ratioLimit = DEFAULT_STRENGTH_V2_PARAMS.shrinkRatio
  // 方案一后衰竭窗不含信号根：now = [k−m, k−1]，prev = [k−2m, k−m−1]（m 通用）
  for (const [c, sigIdx, wantFlat] of [[flat, 22, true], [shrink, 23, false]]) {
    const closes = s2Closes(c)
    const k = sigIdx - (caseParams(c).period - 1)
    const m = DEFAULT_STRENGTH_V2_PARAMS.exhaustWindow
    const bodies = []
    for (let j = k - 2 * m; j <= k - 1; j++) bodies.push(Math.abs(closes[j] - closes[j - 1]))
    const nowB = bodies.slice(m)
    const prevB = bodies.slice(0, m)
    const nowMean = nowB.reduce((a, b) => a + b, 0) / m
    const prevMean = prevB.reduce((a, b) => a + b, 0) / m
    const allSmall = nowB.every((b) => b <= eps)
    const shrinkOk = prevMean > 0 && nowMean / prevMean <= ratioLimit
    if (wantFlat) {
      assert.ok(allSmall, "flat 用例应满足走平")
      assert.ok(!shrinkOk, `flat 用例收缩比不应成立（${nowMean}/${prevMean}）`)
    } else {
      assert.ok(!allSmall, "shrink 用例不应满足走平")
      assert.ok(shrinkOk, `shrink 用例收缩比应成立（${nowMean}/${prevMean}）`)
    }
  }
})

test("ATR 缓冲边界：转红柱低点恰好等于回调低点（≥ 含等号）时中继照常触发", () => {
  // 小周期合成序列：上行确立 → 单根回调（低点 L）→ 转红柱低点恰为 L
  const bars = [
    { time: "t0", open: 100, high: 100.5, low: 99.6, close: 100.2 },
  ]
  const push = (arr, step, wick) => {
    const o = arr.at(-1).close
    const c = Math.round((o + step) * 100) / 100
    arr.push({ time: `t${arr.length}`, open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c })
  }
  for (const st of [1.0, 1.0, 1.1, 1.1, 1.2, 1.2]) push(bars, st, 0.2)
  const o1 = bars.at(-1).close
  bars.push({ time: "t7", open: o1, high: o1 - 0.8, low: o1 - 1.4, close: o1 - 1.0 }) // 回调根：低点 L = o1−1.4
  const o2 = bars.at(-1).close
  bars.push({ time: "t8", open: o2, high: o2 + 1.4, low: o2 - 0.4, close: o2 + 1.2 }) // 转红根：低点 = o2−0.4 = L（恰相等）
  push(bars, 1.0, 0.2)
  push(bars, 1.0, 0.2)
  const params = { ...DEFAULT_STRENGTH_V2_PARAMS, period: 4, atrPeriod: 2 }
  const res = calcStrengthV2(bars, params)
  assert.equal(bars[7].low, bars[8].low, "合成前提：两根低点应恰相等")
  assert.ok(
    res.signals.some((s) => s.kind === "continuation_long"),
    `恰等低点应触发中继，实际 ${JSON.stringify(res.signals)}`,
  )
})
