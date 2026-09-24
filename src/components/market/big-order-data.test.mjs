import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_BIG_ORDER_SETTINGS,
  DEFAULT_FILTER,
  isBigOrderHit,
  bigOrderColor,
  bigOrderThreshold,
  passesFilter,
  isFilterActive,
  bjTradingDay,
} from "./big-order-data.mjs"

test("isBigOrderHit 命中：达阈值且方向启用", () => {
  assert.equal(isBigOrderHit("buy", 100, DEFAULT_BIG_ORDER_SETTINGS), true)
  assert.equal(isBigOrderHit("buy", 99, DEFAULT_BIG_ORDER_SETTINGS), false)
  assert.equal(isBigOrderHit("sell", 150, DEFAULT_BIG_ORDER_SETTINGS), true)
  assert.equal(isBigOrderHit("sell", 100, DEFAULT_BIG_ORDER_SETTINGS), true)
})

test("isBigOrderHit 方向禁用时不命中", () => {
  const s = { ...DEFAULT_BIG_ORDER_SETTINGS, buy_enabled: false }
  assert.equal(isBigOrderHit("buy", 500, s), false)
  assert.equal(isBigOrderHit("sell", 500, s), true)
})

test("isBigOrderHit 非法方向不命中", () => {
  assert.equal(isBigOrderHit("big", 1000, DEFAULT_BIG_ORDER_SETTINGS), false)
})

test("bigOrderColor / bigOrderThreshold 取对应方向", () => {
  assert.equal(bigOrderColor("buy", DEFAULT_BIG_ORDER_SETTINGS), "#ef4444")
  assert.equal(bigOrderColor("sell", DEFAULT_BIG_ORDER_SETTINGS), "#22c55e")
  assert.equal(bigOrderThreshold("buy", DEFAULT_BIG_ORDER_SETTINGS), 100)
  assert.equal(bigOrderThreshold("sell", DEFAULT_BIG_ORDER_SETTINGS), 100)
})

test("passesFilter：默认通过全部", () => {
  assert.equal(passesFilter("buy", 10, DEFAULT_FILTER), true)
  assert.equal(passesFilter("sell", 10, DEFAULT_FILTER), true)
})

test("passesFilter：方向筛选", () => {
  const f = { direction: "buy", minVolume: 0 }
  assert.equal(passesFilter("buy", 10, f), true)
  assert.equal(passesFilter("sell", 10, f), false)
})

test("passesFilter：最小手数筛选", () => {
  const f = { direction: "all", minVolume: 50 }
  assert.equal(passesFilter("buy", 49, f), false)
  assert.equal(passesFilter("buy", 50, f), true)
  assert.equal(passesFilter("buy", 200, f), true)
})

test("passesFilter：方向 + 手数叠加", () => {
  const f = { direction: "sell", minVolume: 100 }
  assert.equal(passesFilter("buy", 200, f), false)
  assert.equal(passesFilter("sell", 50, f), false)
  assert.equal(passesFilter("sell", 200, f), true)
})

test("isFilterActive：默认未激活", () => {
  assert.equal(isFilterActive(DEFAULT_FILTER), false)
  assert.equal(isFilterActive({ direction: "buy", minVolume: 0 }), true)
  assert.equal(isFilterActive({ direction: "all", minVolume: 10 }), true)
})

test("bjTradingDay：日盘属当日", () => {
  // 周三 14:00 → 当日
  assert.equal(bjTradingDay(new Date(2026, 6, 29, 14, 0)), "2026-07-29")
  // 周三 09:30
  assert.equal(bjTradingDay(new Date(2026, 6, 29, 9, 30)), "2026-07-29")
})

test("bjTradingDay：21:00 后属次日", () => {
  // 周三 21:00 → 周四
  assert.equal(bjTradingDay(new Date(2026, 6, 29, 21, 0)), "2026-07-30")
  // 周四 02:00 仍属周四
  assert.equal(bjTradingDay(new Date(2026, 6, 30, 2, 0)), "2026-07-30")
})

test("bjTradingDay：周五夜盘 → 下周一", () => {
  // 周五 21:00 → 下周一
  assert.equal(bjTradingDay(new Date(2026, 6, 31, 21, 0)), "2026-08-03")
})
