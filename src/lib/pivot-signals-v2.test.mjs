/**
 * pivot-signals-v2.ts 与后端 signal_pivot_v2.py 的口径一致性测试
 *
 * 本文件为纯 JS（.mjs），通过 Node 22 原生 TS 支持直接 import ./pivot-signals-v2.ts
 * （先例：components/backtest/timeframe-limits.test.mjs）。
 *
 * 分工：算法正确性由后端 tests/test_signal_pivot_v2.py 权威验证；本文件只
 * 证明 TS 实现与后端逐项一致——两边共读同一份 fixture
 * `backend/tests/fixtures/pivot_v2_cases.json`（由后端实现生成，后端单测
 * test_fixture_matches_implementation 守护其不过期）。
 *
 * 跑法：node --test src/lib/pivot-signals-v2.test.mjs（在 frontend 目录下）
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { calcPivotSignalsV2 } from "./pivot-signals-v2.ts"

// src/lib → 上溯 2 层到仓库根(fixture 镜像在 desktop/backend/)
const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "backend",
  "tests",
  "fixtures",
  "pivot_v2_cases.json",
)

const payload = JSON.parse(readFileSync(FIXTURE, "utf-8"))

/** 后端参数名（snake_case）→ 前端 options（camelCase），并补齐默认值 */
function toOptions(params) {
  return {
    proximityAtrMult: params.proximity_atr_mult ?? 1.0,
    wickAtrMult: params.wick_atr_mult ?? 0.8,
    attackWindow: params.attack_window ?? 3,
    volExpandRatio: params.vol_expand_ratio ?? 1.5,
    volShrinkRatio: params.vol_shrink_ratio ?? 0.7,
    volMaPeriod: params.vol_ma_period ?? 20,
    cooldown: params.cooldown ?? 5,
    atrPeriod: params.atr_period ?? 14,
    markInvalidated: params.mark_invalidated ?? true,
    invalidateAtrMult: params.invalidate_atr_mult ?? 0,
  }
}

function normalize(signals) {
  return signals.map((s) => ({
    index: s.index,
    side: s.side,
    price: Number(s.price.toFixed(6)),
    ref_index: s.refIndex,
    pattern: s.pattern,
    invalidated: s.invalidated ?? null,
    invalidated_at: s.invalidatedAt ?? null,
  }))
}

test("fixture 覆盖了全部关键分支", () => {
  const names = payload.cases.map((c) => c.name)
  for (const expected of [
    "default",
    "loose",
    "strict",
    "cooldown0",
    "invalidation_buffer",
    "mark_off",
  ]) {
    assert.ok(names.includes(expected), `fixture 缺用例 ${expected}`)
  }
  assert.ok(payload.bars.length > 100, "fixture bars 太少，覆盖不足")
})

for (const testCase of payload.cases) {
  test(`TS 与后端一致：${testCase.name}`, () => {
    const params = testCase.params
    const actual = calcPivotSignalsV2(
      payload.bars,
      params.left ?? 3,
      params.right ?? 3,
      toOptions(params),
    )
    assert.deepEqual(normalize(actual), testCase.expected)
  })
}

test("默认参数产出双侧、双形态且有假信号（语料有效性）", () => {
  const signals = calcPivotSignalsV2(
    payload.bars,
    3,
    3,
    toOptions({}),
  )
  assert.ok(signals.length > 0, "语料应产出信号")
  assert.ok(signals.some((s) => s.side === "short"), "语料应覆盖做空")
  assert.ok(signals.some((s) => s.side === "long"), "语料应覆盖做多")
  assert.ok(
    signals.some((s) => s.pattern === "wick_expand"),
    "语料应覆盖放量拒绝",
  )
  assert.ok(
    signals.some((s) => s.pattern === "attack_shrink"),
    "语料应覆盖缩量失败",
  )
  assert.ok(
    signals.some((s) => s.invalidated === true),
    "语料应覆盖假信号（突破参考极值）",
  )
})

test("宽松阈值产出不少于默认（阈值方向性）", () => {
  const deflt = calcPivotSignalsV2(payload.bars, 3, 3, toOptions({}))
  const loose = calcPivotSignalsV2(
    payload.bars,
    3,
    3,
    toOptions({
      proximity_atr_mult: 2.0,
      wick_atr_mult: 0.3,
      vol_expand_ratio: 1.2,
      vol_shrink_ratio: 0.8,
    }),
  )
  assert.ok(loose.length > deflt.length, "放宽阈值后信号数应增加")
})

test("markInvalidated=false 不写失效字段（退化等价）", () => {
  const signals = calcPivotSignalsV2(
    payload.bars,
    3,
    3,
    toOptions({ mark_invalidated: false }),
  )
  assert.ok(signals.length > 0)
  assert.ok(
    signals.every(
      (s) => s.invalidated === undefined && s.invalidatedAt === undefined,
    ),
  )
})

test("末根（形成中）不作为触发 bar", () => {
  // 截掉最后一根：若末根本来就不是触发 bar，信号集应与全集完全一致
  const full = calcPivotSignalsV2(payload.bars, 3, 3, toOptions({}))
  const cut = calcPivotSignalsV2(payload.bars.slice(0, -1), 3, 3, toOptions({}))
  assert.deepEqual(
    cut.map((s) => [s.index, s.side]),
    full.map((s) => [s.index, s.side]),
    "截掉末根不应改变信号集",
  )
})
