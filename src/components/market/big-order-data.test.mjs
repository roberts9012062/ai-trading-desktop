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

// 大单提醒默认全关后，命中判定测试统一用显式开启的设置
const ALL_ON = {
  ...DEFAULT_BIG_ORDER_SETTINGS,
  buy_enabled: true,
  sell_enabled: true,
}

test("默认设置：大单提醒全关", () => {
  assert.equal(DEFAULT_BIG_ORDER_SETTINGS.buy_enabled, false)
  assert.equal(DEFAULT_BIG_ORDER_SETTINGS.sell_enabled, false)
  assert.equal(DEFAULT_BIG_ORDER_SETTINGS.popup_enabled, false)
  assert.equal(DEFAULT_BIG_ORDER_SETTINGS.sound_enabled, false)
  assert.equal(DEFAULT_BIG_ORDER_SETTINGS.voice_enabled, false)
})

test("isBigOrderHit 命中：达阈值且方向启用", () => {
  assert.equal(isBigOrderHit("buy", 100, ALL_ON), true)
  assert.equal(isBigOrderHit("buy", 99, ALL_ON), false)
  assert.equal(isBigOrderHit("sell", 150, ALL_ON), true)
  assert.equal(isBigOrderHit("sell", 100, ALL_ON), true)
})

test("isBigOrderHit 默认设置（全关）不命中", () => {
  assert.equal(isBigOrderHit("buy", 10000, DEFAULT_BIG_ORDER_SETTINGS), false)
  assert.equal(isBigOrderHit("sell", 10000, DEFAULT_BIG_ORDER_SETTINGS), false)
})

test("isBigOrderHit 方向禁用时不命中", () => {
  const s = { ...ALL_ON, buy_enabled: false }
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
