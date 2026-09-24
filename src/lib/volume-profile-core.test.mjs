/**
 * 成交量分布纯逻辑单测 —— node --test 覆盖
 *
 * 口径基准与 web 服务端 tests/test_price_fallback_sina.py /
 * trade_tick_svc 的行为语义对齐（关键边界：开仓率钳制、缺 OI 不拆分、
 * 交易日跳周末、无成交不采集）。
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  emptyAcc,
  tradingDayOfBj,
  bjTimestamp,
  splitOpenClose,
  collectTick,
  applyTick,
  profileRows,
} from "./volume-profile-core.ts"

test("splitOpenClose:全买 + ΔOI=成交 → 全为开多", () => {
  // r = (100+100)/200 = 1 → 开多=100,平空=0,开空=0,平多=0
  const s = splitOpenClose(100, 0, 100)
  assert.deepEqual(s, { openLong: 100, closeLong: 0, openShort: 0, closeShort: 0 })
})

test("splitOpenClose:全买 + ΔOI=-成交 → 全为平空", () => {
  // r = (-100+100)/200 = 0 → 开多=0,平空=100
  const s = splitOpenClose(100, 0, -100)
  assert.deepEqual(s, { openLong: 0, closeLong: 0, openShort: 0, closeShort: 100 })
})

test("splitOpenClose:ΔOI 超界钳制到 [0,1]", () => {
  // ΔOI=999 → r=(999+10)/20>1 钳 1 → 全开仓
  const s = splitOpenClose(10, 10, 999)
  assert.equal(s.openLong + s.closeShort, 10)
  assert.equal(s.openShort + s.closeLong, 10)
  assert.equal(s.closeShort, 0)
  assert.equal(s.closeLong, 0)
})

test("splitOpenClose:oiDelta 缺失/无成交 → null", () => {
  assert.equal(splitOpenClose(10, 0, null), null)
  assert.equal(splitOpenClose(0, 0, 5), null)
})

test("splitOpenClose:买卖各半 + ΔOI=0 → 开平各半(对称中性)", () => {
  // r = (0+100)/200 = 0.5
  const s = splitOpenClose(50, 50, 0)
  assert.equal(s.openLong, 25)
  assert.equal(s.closeShort, 25)
  assert.equal(s.openShort, 25)
  assert.equal(s.closeLong, 25)
})

function _ob(overrides) {
  return {
    symbol: "RB2610",
    last_direction: "buy",
    stats: {
      current_volume: { value: 30, source: "x", quality: "direct" },
      oi_delta: { value: 10, source: "x", quality: "direct" },
    },
    ...overrides,
  }
}

test("collectTick:正常提取(含四路开平)", () => {
  const t = collectTick(_ob({}), 3450.5, "2026-09-17T21:30:05")
  assert.equal(t.symbol, "rb2610")
  assert.equal(t.direction, "buy")
  assert.equal(t.volume, 30)
  assert.equal(t.price, 3450.5)
  // 全买 30 + ΔOI=10 → r=(10+30)/60=2/3 → 开多=20,平空=10
  assert.deepEqual(t.split, { openLong: 20, closeLong: 0, openShort: 0, closeShort: 10 })
})

test("collectTick:无成交/缺价格/缺 symbol → null", () => {
  assert.equal(collectTick(_ob({ stats: { current_volume: { value: 0 } } }), 100, "x"), null)
  assert.equal(collectTick(_ob({}), null, "x"), null)
  assert.equal(collectTick(_ob({}), 0, "x"), null)
  assert.equal(collectTick(_ob({ symbol: "" }), 100, "x"), null)
})

test("collectTick:缺 oi_delta → 四路 null 仍采集", () => {
  const t = collectTick(_ob({ stats: { current_volume: { value: 5 } } }), 100, "x")
  assert.equal(t.volume, 5)
  assert.equal(t.split, null)
})

test("collectTick:方向不明 → 四路 null 仍采集", () => {
  const t = collectTick(_ob({ last_direction: "" }), 100, "x")
  assert.equal(t.direction, "")
  assert.equal(t.split, null)
})

test("collectTick:浮点价格收敛到 4 位(同价落同档)", () => {
  const a = collectTick(_ob({}), 3450.123456, "x")
  const b = collectTick(_ob({}), 3450.1235, "x")
  assert.equal(a.price, b.price)
})

test("applyTick:增量聚合 + 派生列 + asof/last_price 推进", () => {
  let acc = emptyAcc()
  acc = applyTick(acc, {
    symbol: "rb2610", direction: "buy", volume: 30, price: 3450,
    occurredAt: "2026-09-17T21:30:01",
    split: { openLong: 20, closeLong: 0, openShort: 0, closeShort: 10 },
  })
  acc = applyTick(acc, {
    symbol: "rb2610", direction: "sell", volume: 10, price: 3450,
    occurredAt: "2026-09-17T21:30:05",
    split: { openLong: 0, closeLong: 5, openShort: 5, closeShort: 0 },
  })
  acc = applyTick(acc, {
    symbol: "rb2610", direction: "buy", volume: 8, price: 3460,
    occurredAt: "2026-09-17T21:30:09",
    split: null,
  })
  const rows = profileRows(acc)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    price: 3450, open_long: 20, close_long: 5, open_short: 5, close_short: 10,
    total: 40, buy_total: 30, sell_total: 10,
  })
  // 无拆分档四路为 0,total 仍计
  assert.deepEqual(rows[1], {
    price: 3460, open_long: 0, close_long: 0, open_short: 0, close_short: 0,
    total: 8, buy_total: 0, sell_total: 0,
  })
  assert.equal(acc.asof, "2026-09-17T21:30:09")
  assert.equal(acc.last_price, 3460)
})

test("applyTick:纯函数不改入参", () => {
  const acc = emptyAcc()
  const next = applyTick(acc, {
    symbol: "a", direction: "buy", volume: 1, price: 1,
    occurredAt: "t", split: null,
  })
  assert.equal(Object.keys(acc.rows).length, 0)
  assert.equal(acc.asof, null)
  assert.equal(Object.keys(next.rows).length, 1)
})

test("tradingDayOfBj:白天归当日 / 21点后归次日 / 周五夜盘归下周一", () => {
  // 北京 2026-09-17(周四) 10:00 = UTC 02:00
  assert.equal(tradingDayOfBj(new Date("2026-09-17T02:00:00Z")), "2026-09-17")
  // 北京 2026-09-17(周四) 21:30 = UTC 13:30 → 归周五
  assert.equal(tradingDayOfBj(new Date("2026-09-17T13:30:00Z")), "2026-09-18")
  // 北京 2026-09-18(周五) 22:00 = UTC 14:00 → 周六跳到下周一 09-21
  assert.equal(tradingDayOfBj(new Date("2026-09-18T14:00:00Z")), "2026-09-21")
  // 北京 2026-09-19(周六) 10:00 = UTC 02:00 → 白天周末也归下周一
  assert.equal(tradingDayOfBj(new Date("2026-09-19T02:00:00Z")), "2026-09-21")
  // 北京 2026-09-20(周日) 02:00 = UTC 前一天 18:00 → 下周一
  assert.equal(tradingDayOfBj(new Date("2026-09-19T18:00:00Z")), "2026-09-21")
})

test("bjTimestamp:北京时间格式化", () => {
  assert.equal(bjTimestamp(new Date("2026-09-17T13:30:05Z")), "2026-09-17T21:30:05")
})
