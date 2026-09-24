/**
 * 语音播报纯逻辑单测 —— node --test 覆盖
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  MAX_ITEMS,
  ALLOWED_INTERVALS,
  isValidInterval,
  clampRate,
  isQuoteFresh,
  bucketOf,
  collectDue,
  enqueueDedup,
  formatPrice,
  buildBroadcastText,
  sanitizeSettings,
} from "./voice-broadcast-core.mjs"

const MIN = 60_000

test("interval 校验：仅允许 1/5/10/15/30/60", () => {
  for (const v of ALLOWED_INTERVALS) assert.equal(isValidInterval(v), true)
  for (const v of [0, 2, 7, 45, 90, "x", null, undefined]) {
    assert.equal(isValidInterval(v), false, `interval=${v}`)
  }
})

test("bucket 整分墙钟对齐：5m 桶在 :00/:05 跳档", () => {
  const t0 = 26 * 60 * MIN // 整分
  assert.equal(bucketOf(t0, 5), bucketOf(t0 + 4 * MIN + 59_999, 5))
  assert.equal(bucketOf(t0, 5) + 1, bucketOf(t0 + 5 * MIN, 5))
  // 1m 与 5m 在 5 分钟边界同刻到点（排队播报的触发条件）
  assert.equal(bucketOf(t0, 1), bucketOf(t0, 1))
})

test("collectDue：同刻多品种按配置顺序返回，首见播种不播报", () => {
  const items = [
    { code: "M", name: "豆粕", intervalMin: 1, enabled: true },
    { code: "RB", name: "螺纹钢", intervalMin: 5, enabled: true },
    { code: "CU", name: "沪铜", intervalMin: 60, enabled: true },
    { code: "AG", name: "沪银", intervalMin: 5, enabled: false },
  ]
  const now = 3 * 60 * MIN // 3 小时整：1m/5m/60m 全部跨桶
  const last = new Map([
    ["M", bucketOf(now - MIN, 1)],
    ["RB", bucketOf(now - MIN, 5)],
    ["CU", bucketOf(now - MIN, 60)],
  ])
  // 配置顺序（AG 禁用跳过）
  assert.deepEqual(
    collectDue(items, now, last).map((d) => d.code),
    ["M", "RB", "CU"],
  )
  // 桶号已更新：同桶再跑不重复到点
  assert.deepEqual(collectDue(items, now + 30_000, last).map((d) => d.code), [])
  // 下一分钟只有 1m 到点
  assert.deepEqual(
    collectDue(items, now + MIN, last).map((d) => d.code),
    ["M"],
  )
  // 首见（页面刷新/刚启用）：只播种当前桶，不立即播报（防刷新即全量播）
  const fresh = new Map()
  assert.deepEqual(collectDue(items, now + 20_000, fresh).map((d) => d.code), [])
  // 下一分钟边界才到点（1m 触发；5m/60m 仍在同桶）
  assert.deepEqual(
    collectDue(items, now + MIN + 1_000, fresh).map((d) => d.code),
    ["M"],
  )
})

test("enqueueDedup：同品种在队则跳过，空文案不入队", () => {
  const queue = [{ code: "M", text: "豆粕…" }]
  const out = enqueueDedup(queue, [
    { code: "M", text: "豆粕…again" }, // 重复跳过
    { code: "RB", text: "螺纹钢…" },
    { code: "CU", text: "" }, // 空跳过
    { code: "AG" }, // 无文案跳过
  ])
  assert.deepEqual(
    out.map((e) => e.code),
    ["M", "RB"],
  )
  // 入参不被修改
  assert.equal(queue.length, 1)
})

test("formatPrice：按小数位格式化，非法值空串", () => {
  assert.equal(formatPrice(3012.5, 1), "3012.5")
  assert.equal(formatPrice(3012.5, 0), "3013")
  assert.equal(formatPrice(3012.5), "3012.50")
  assert.equal(formatPrice(NaN), "")
  assert.equal(formatPrice("x"), "")
  assert.equal(formatPrice(1.2, 99), "1.20") // 非法小数位回落 2
})

test("buildBroadcastText：最新价+涨跌幅，涨/跌/持平三分支", () => {
  assert.equal(
    buildBroadcastText("豆粕", { last_price: 3012.5, change_pct: 1.25, decimal_places: 1 }),
    "豆粕 最新价3012.5 上涨1.25%",
  )
  assert.equal(
    buildBroadcastText("螺纹钢", { last_price: 3057, change_pct: -0.83, decimal_places: 0 }),
    "螺纹钢 最新价3057 下跌0.83%",
  )
  assert.equal(
    buildBroadcastText("沪铜", { last_price: 71230, change_pct: 0, decimal_places: 0 }),
    "沪铜 最新价71230 持平",
  )
  // 无行情 / 无效价 → 空（跳过播报）
  assert.equal(buildBroadcastText("豆粕", null), "")
  assert.equal(buildBroadcastText("豆粕", { last_price: 0, change_pct: 1 }), "")
})

test("sanitizeSettings：条数≤4、去重、周期非法剔除、语速/声音规整", () => {
  const out = sanitizeSettings({
    enabled: 1,
    voiceId: "zh-CN-YunxiNeural",
    rate: 3.5,
    items: [
      { code: "m", name: "豆粕", intervalMin: "5", enabled: 0 },
      { code: "M", name: "重复", intervalMin: 1 }, // 与 m 去重（大小写归一）
      { code: "RB", intervalMin: 7 }, // 周期非法剔除
      { code: "RB", intervalMin: 10 }, // 剔除后首个合法 RB 保留
      { code: "CU", intervalMin: 60, enabled: true },
      { code: "AU", intervalMin: 15 },
      { code: "AG", intervalMin: 30 },
      { code: "AL", intervalMin: 1 }, // 超出 4 条截断
      { nope: true },
    ],
  })
  assert.equal(out.enabled, true)
  assert.deepEqual(
    out.items.map((i) => `${i.code}:${i.intervalMin}`),
    ["M:5", "RB:10", "CU:60", "AU:15"],
  )
  // 字符串周期规整为数字；enabled 默认 true
  assert.equal(out.items[0].intervalMin, 5)
  assert.equal(out.items[0].enabled, false) // enabled:0 → false
  assert.equal(out.items[1].enabled, true)
  // 音色 ID 保留、语速收敛到上限 2.0
  assert.equal(out.voiceId, "zh-CN-YunxiNeural")
  assert.equal(out.rate, 2.0)
  // 脏输入兜底（新字段默认值）
  assert.deepEqual(sanitizeSettings(null), {
    enabled: false,
    items: [],
    voiceId: "",
    rate: 1.0,
  })
  assert.deepEqual(sanitizeSettings("junk"), {
    enabled: false,
    items: [],
    voiceId: "",
    rate: 1.0,
  })
})

test("clampRate：语速收敛 [0.5, 2.0]，非法回落 1.0", () => {
  assert.equal(clampRate(1.2), 1.2)
  assert.equal(clampRate(0.1), 0.5)
  assert.equal(clampRate(9), 2.0)
  assert.equal(clampRate("1.5"), 1.5)
  assert.equal(clampRate(NaN), 1.0)
  assert.equal(clampRate(undefined), 1.0)
})

test("isQuoteFresh：停盘门控（recv_ts 优先，tick_time 回落）", () => {
  const now = Date.parse("2026-09-03T10:00:00+08:00")
  // 交易中：recv_ts 10 秒前（秒级时间戳）
  assert.equal(isQuoteFresh({ recv_ts: now / 1000 - 10 }, now), true)
  // 停盘：recv_ts 10 分钟前
  assert.equal(isQuoteFresh({ recv_ts: now / 1000 - 600 }, now), false)
  // 边界：恰好 180 秒（含）
  assert.equal(isQuoteFresh({ recv_ts: now / 1000 - 180 }, now), true)
  assert.equal(isQuoteFresh({ recv_ts: now / 1000 - 181 }, now), false)
  // 无 recv_ts：回落 tick_time（北京时间交易所时间）
  assert.equal(isQuoteFresh({ tick_time: "2026-09-03 09:59:30" }, now), true)
  assert.equal(isQuoteFresh({ tick_time: "2026-09-03 09:40:00" }, now), false)
  // 两者皆缺/脏数据：视为不新鲜（宁可不播）
  assert.equal(isQuoteFresh({}, now), false)
  assert.equal(isQuoteFresh(null, now), false)
  assert.equal(isQuoteFresh({ tick_time: "垃圾" }, now), false)
})
