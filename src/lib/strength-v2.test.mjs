/**
 * strength-v2.ts 与后端 signal_strength_v2.py 的口径一致性测试（对齐 + 通用性质）
 *
 * 分工同 strength-index.test.mjs：算法正确性由后端 tests/test_signal_strength_v2.py
 * 权威验证；本文件证明 TS 实现与共享 fixture 逐位一致，并守护通用性质
 * （预热 / 一字板 / 蜡烛连续与保序 / 判定=显示 / 冷却与同根唯一 /
 * 因果重放不撤销 / pending 标记）。V2 形态档的规格断言见
 * strength-v2-spec.test.mjs。
 *
 * 跑法：node --test src/lib/strength-v2.test.mjs（在 frontend 目录下）
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  calcStrengthV2,
  DEFAULT_STRENGTH_V2_PARAMS,
} from "./strength-v2.ts"

const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "backend", "tests", "fixtures", "strength_v2_cases.json"),
    "utf8",
  ),
)

const TOL = 1e-9

/** 取某用例的 bars（默认共享主线，可被用例自带 bars 覆盖） */
export function caseBars(c) {
  const raw = c.bars ?? FIXTURE.bars
  return raw.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
}

/** 用例参数（fixture 存 camelCase，合到默认值上） */
export function caseParams(c) {
  return { ...DEFAULT_STRENGTH_V2_PARAMS, ...c.params }
}

/** 用例的 S2 序列（取自输出点 close，与判定序列同一条 —— 第三节地基） */
export function s2Closes(c) {
  return c.expected_points.map((p) => p.close)
}

export const CASE = Object.fromEntries(FIXTURE.cases.map((c) => [c.name, c]))
export { FIXTURE, TOL }

// —— fixture 逐位对齐（全部用例：点 / 信号 / regime）——
for (const c of FIXTURE.cases) {
  test(`fixture 对齐：${c.name}`, () => {
    const bars = caseBars(c)
    const params = caseParams(c)
    const res = calcStrengthV2(bars, params)
    assert.equal(res.points.length, c.expected_points.length, "点数不一致")
    for (let k = 0; k < res.points.length; k++) {
      const e = c.expected_points[k]
      const p = res.points[k]
      assert.equal(e.index, params.period - 1 + k, "expected_points.index 应为 bar 绝对下标")
      assert.equal(p.time, bars[e.index].time, "点 time 对应 bar 下标错位")
      for (const key of ["open", "high", "low", "close"]) {
        assert.ok(Math.abs(p[key] - e[key]) < TOL, `点[${k}].${key}: ${p[key]} ≠ ${e[key]}`)
      }
    }
    assert.equal(res.signals.length, c.expected_signals.length, "信号数不一致")
    for (let k = 0; k < res.signals.length; k++) {
      const e = c.expected_signals[k]
      const s = res.signals[k]
      assert.equal(s.index, e.index)
      assert.equal(s.time, bars[e.index].time)
      assert.equal(s.kind, e.kind)
      assert.ok(Math.abs(s.value - e.value) < TOL, `信号[${k}].value: ${s.value} ≠ ${e.value}`)
      assert.equal(s.pending, e.pending)
    }
    assert.deepEqual(res.regimes, c.expected_regimes, "regime 序列不一致")
  })
}

// —— 通用性质（全部用例）——

test("预热：bars 少于 period 无输出；恰为 period 输出 1 点", () => {
  const bars = caseBars(CASE.default)
  const p14 = { ...DEFAULT_STRENGTH_V2_PARAMS, period: 14 }
  const empty = calcStrengthV2(bars.slice(0, 13), p14)
  assert.equal(empty.points.length, 0)
  assert.equal(empty.signals.length, 0)
  assert.equal(empty.regimes.length, 0)
  const one = calcStrengthV2(bars.slice(0, 14), p14)
  assert.equal(one.points.length, 1)
  assert.equal(one.signals.length, 0)
})

test("一字板：range==0 时 raw 取 50，全序列恒 50 且 regime 恒 none", () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({
    time: `2026-01-02 09:${String(i).padStart(2, "0")}:00`,
    open: 88, high: 88, low: 88, close: 88,
  }))
  const res = calcStrengthV2(flat, DEFAULT_STRENGTH_V2_PARAMS)
  assert.ok(res.points.length > 0)
  for (const p of res.points) {
    assert.equal(p.open, 50)
    assert.equal(p.high, 50)
    assert.equal(p.low, 50)
    assert.equal(p.close, 50)
  }
  assert.ok(res.regimes.every((r) => r === "none"))
})

test("蜡烛连续 + 保序界内（全部用例）", () => {
  for (const c of FIXTURE.cases) {
    for (let k = 1; k < c.expected_points.length; k++) {
      assert.equal(c.expected_points[k].open, c.expected_points[k - 1].close, `${c.name} 蜡烛不连续 @k=${k}`)
    }
    for (const p of c.expected_points) {
      assert.ok(p.high >= p.close && p.close >= p.low, `${c.name} 保序破坏`)
      for (const key of ["open", "high", "low", "close"]) {
        assert.ok(p[key] >= 0 && p[key] <= 100, `${c.name} ${key}=${p[key]} 越界`)
      }
    }
  }
})

test("判定=显示：每个信号 value 恒等于触发 bar 输出点的 close（第三节地基守护）", () => {
  for (const c of FIXTURE.cases) {
    for (const s of c.expected_signals) {
      const k = s.index - (caseParams(c).period - 1)
      assert.equal(s.value, c.expected_points[k].close, `${c.name} 信号@${s.index} value ≠ 显示序列 close`)
    }
  }
})

test("同档冷却与同根唯一（全部用例）", () => {
  for (const c of FIXTURE.cases) {
    const cooldown = caseParams(c).cooldown
    const last = {}
    const seen = new Set()
    for (const s of c.expected_signals) {
      assert.ok(s.index - (last[s.kind] ?? -Infinity) >= cooldown, `${c.name} ${s.kind}@${s.index} 冷却不足`)
      last[s.kind] = s.index
      assert.ok(!seen.has(s.index), `${c.name} bar ${s.index} 出现多个信号`)
      seen.add(s.index)
    }
  }
})

test("因果重放：任意前缀运行的非 pending 信号与全量运行逐项一致（不撤销）", () => {
  const bars = caseBars(CASE.default)
  const full = calcStrengthV2(bars, DEFAULT_STRENGTH_V2_PARAMS)
  for (const L of [20, 30, 40, 50, 60, 70, 79]) {
    const prefix = calcStrengthV2(bars.slice(0, L), DEFAULT_STRENGTH_V2_PARAMS)
    const prefixClosed = prefix.signals.filter((s) => !s.pending)
    const fullClosed = full.signals.filter((s) => s.index <= L - 2)
    assert.deepEqual(prefixClosed, fullClosed, `前缀 L=${L} 重放不一致`)
  }
  // 状态机重的翻转用例同样重放一遍
  const fb = caseBars(CASE.flip_bar_not_pullback)
  const fbFull = calcStrengthV2(fb, DEFAULT_STRENGTH_V2_PARAMS)
  for (const L of [18, 22, 25, 30]) {
    const prefix = calcStrengthV2(fb.slice(0, L), DEFAULT_STRENGTH_V2_PARAMS)
    const prefixClosed = prefix.signals.filter((s) => !s.pending)
    const fullClosed = fbFull.signals.filter((s) => s.index <= L - 2)
    assert.deepEqual(prefixClosed, fullClosed, `flip 前缀 L=${L} 重放不一致`)
  }
})

test("pending：已知信号落到序列末根时标记 pending=true", () => {
  const bars = caseBars(CASE.bottom_exhaust_flat)
  const res = calcStrengthV2(bars.slice(0, 23), DEFAULT_STRENGTH_V2_PARAMS)
  const sig = res.signals.find((s) => s.kind === "bottom_exhaust")
  assert.ok(sig, "截断序列应仍有 bottom_exhaust")
  assert.equal(sig.index, 22)
  assert.equal(sig.pending, true)
})
