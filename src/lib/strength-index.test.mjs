/**
 * strength-index.ts 与后端 signal_strength.py 的口径一致性测试
 *
 * 分工同 pivot-signals-v2.test.mjs：算法正确性由后端 tests/test_signal_strength.py
 * 权威验证；本文件证明 TS 实现与共享 fixture 逐位一致，并用独立性质断言
 * 守护规格（预热边界 / 一字板取 50 / 蜡烛连续 / 保序界内 / 同档冷却 /
 * 优先级单信号 / 因果重放不撤销 / pending 标记）。
 *
 * 跑法：node --test src/lib/strength-index.test.mjs（在 frontend 目录下）
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  calcStrength,
  DEFAULT_STRENGTH_PARAMS,
} from "./strength-index.ts"

const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "backend", "tests", "fixtures", "strength_cases.json"),
    "utf8",
  ),
)

/** fixture bars（time/OHLC 即内核输入，volume 不参与计算） */
const bars = FIXTURE.bars.map((b) => ({
  time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
}))

/** 逐位对齐容差（期望值为 round2 产物，正常应精确相等） */
const TOL = 1e-9

// —— fixture 逐位对齐（全部用例）——
for (const c of FIXTURE.cases) {
  test(`fixture 对齐：${c.name}`, () => {
    const res = calcStrength(bars, c.params)
    assert.equal(res.points.length, c.expected_points.length, "点数不一致")
    for (let k = 0; k < res.points.length; k++) {
      const e = c.expected_points[k]
      const p = res.points[k]
      assert.equal(e.index, c.params.period - 1 + k, "expected_points.index 应为 bar 绝对下标")
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
  })
}

// —— 性质断言（独立于 fixture 期望值，直接守护规格）——

test("预热：bars 少于 period 无输出；恰为 period 输出 1 点", () => {
  const p13 = { ...DEFAULT_STRENGTH_PARAMS, period: 14 }
  const empty = calcStrength(bars.slice(0, 13), p13)
  assert.equal(empty.points.length, 0)
  assert.equal(empty.signals.length, 0)
  const one = calcStrength(bars.slice(0, 14), p13)
  assert.equal(one.points.length, 1)
  assert.equal(one.signals.length, 0)
})

test("一字板：range==0 时 raw 取 50，全序列恒 50", () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({
    time: `2026-01-02 09:${String(i).padStart(2, "0")}:00`,
    open: 88, high: 88, low: 88, close: 88,
  }))
  for (const params of [
    { ...DEFAULT_STRENGTH_PARAMS },
    { ...DEFAULT_STRENGTH_PARAMS, smooth: 5, smooth2: 4, period: 7 },
  ]) {
    const res = calcStrength(flat, params)
    assert.ok(res.points.length > 0)
    for (const p of res.points) {
      assert.equal(p.open, 50)
      assert.equal(p.high, 50)
      assert.equal(p.low, 50)
      assert.equal(p.close, 50)
    }
  }
})

test("蜡烛连续：open[k] === close[k-1]（二次平滑 open 承接前根 close）", () => {
  const res = calcStrength(bars, DEFAULT_STRENGTH_PARAMS)
  for (let k = 1; k < res.points.length; k++) {
    assert.equal(res.points[k].open, res.points[k - 1].close)
  }
})

test("保序与界内：high ≥ close ≥ low 且全部 ∈ [0,100]", () => {
  for (const c of FIXTURE.cases) {
    const res = calcStrength(bars, c.params)
    for (const p of res.points) {
      assert.ok(p.high >= p.close, `high(${p.high}) < close(${p.close})`)
      assert.ok(p.close >= p.low, `close(${p.close}) < low(${p.low})`)
      for (const key of ["open", "high", "low", "close"]) {
        assert.ok(p[key] >= 0 && p[key] <= 100, `${key}=${p[key]} 越界`)
      }
    }
  }
})

test("同档冷却：同档信号 index 间隔 ≥ cooldown", () => {
  const res = calcStrength(bars, DEFAULT_STRENGTH_PARAMS)
  const last = { swing: -Infinity, rebound: -Infinity, deep: -Infinity }
  for (const s of res.signals) {
    assert.ok(s.index - last[s.kind] >= DEFAULT_STRENGTH_PARAMS.cooldown, `${s.kind}@${s.index} 距上次 ${last[s.kind]} 不足冷却`)
    last[s.kind] = s.index
  }
})

test("优先级：同一根 bar 至多一个信号", () => {
  for (const c of FIXTURE.cases) {
    const seen = new Set()
    for (const s of c.expected_signals) {
      assert.ok(!seen.has(s.index), `bar ${s.index} 出现多个信号`)
      seen.add(s.index)
    }
  }
})

test("因果重放：任意前缀运行的非 pending 信号与全量运行逐项一致（不撤销）", () => {
  const full = calcStrength(bars, DEFAULT_STRENGTH_PARAMS)
  for (const L of [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 76]) {
    const prefix = calcStrength(bars.slice(0, L), DEFAULT_STRENGTH_PARAMS)
    const prefixClosed = prefix.signals.filter((s) => !s.pending)
    const fullClosed = full.signals.filter((s) => s.index <= L - 2)
    assert.deepEqual(prefixClosed, fullClosed, `前缀 L=${L} 重放不一致`)
  }
})

test("pending：已知信号落到序列末根时标记 pending=true", () => {
  // default 全量在 bar15 有 swing；截断到 16 根后 bar15 成为末根
  const res = calcStrength(bars.slice(0, 16), DEFAULT_STRENGTH_PARAMS)
  const swing = res.signals.find((s) => s.kind === "swing")
  assert.ok(swing, "截断序列应仍有 swing")
  assert.equal(swing.index, 15)
  assert.equal(swing.pending, true)
})

test("二次平滑只改点不改信号：smooth2_on 与 default 信号逐项相同", () => {
  const a = FIXTURE.cases.find((c) => c.name === "default")
  const b = FIXTURE.cases.find((c) => c.name === "smooth2_on")
  assert.deepEqual(b.expected_signals, a.expected_signals)
})

test("warmup_boundary：period 等于 bars 长度时恰 1 点且无信号", () => {
  const c = FIXTURE.cases.find((x) => x.name === "warmup_boundary")
  assert.equal(c.expected_points.length, 1)
  assert.equal(c.expected_points[0].index, bars.length - 1)
  assert.equal(c.expected_signals.length, 0)
})

test("all_thresholds_high：阈值不可达时零信号", () => {
  const c = FIXTURE.cases.find((x) => x.name === "all_thresholds_high")
  assert.equal(c.expected_signals.length, 0)
  assert.ok(c.expected_points.length > 0, "点序列仍应正常产出")
})
