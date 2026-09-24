/**
 * 交易时段日历回归 —— 双 K（重复 K 线）修复
 *
 * 2026-08-24 ma2701 15m 实测：本地缓存的旧口径墙钟桶（茶歇后 10:30）
 * 与服务端交易轴口径桶（跨茶歇桶的下一轴点 10:45）并存成双 K。
 * 修复：轴 span 外一律非法 + 周末轴口径与后端（PR #179/#180）同步。
 */

import { describe, expect, it } from "vitest"
import {
  isMinuteBarInSession,
  isSymbolTradingMs,
  isValidMinuteBarTime,
} from "@/lib/trading-sessions"
import { mergeServerBarsWithLocal } from "@/lib/kline-cache"
import type { KlineBar } from "@/types"

/** "2026-08-19 10:20[:30]" → fake-UTC ms(即北京时间墙钟,与库内约定一致) */
function t(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)!
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
}

function bar(time: string, close = 2700): KlineBar {
  return { time, open: close, high: close, low: close, close, volume: 100 }
}

describe("双 K（ma2701 15m 重复 K 线根因）", () => {
  it("周日幽灵 bar(本地引擎旧日历周日误开市合成)一律非法", () => {
    expect(isValidMinuteBarTime("ma2701", "15m", "2026-08-23 21:00:00")).toBe(false)
    expect(isValidMinuteBarTime("ma2701", "15m", "2026-08-23 22:30:00")).toBe(false)
  })

  it("交易日正常轴点合法(周五夜盘/周一日盘/茶歇后——郑商所时段均 15 整除)", () => {
    expect(isValidMinuteBarTime("ma2701", "15m", "2026-08-21 21:00:00")).toBe(true)
    expect(isValidMinuteBarTime("ma2701", "15m", "2026-08-19 10:30:00")).toBe(true)
    expect(isValidMinuteBarTime("ma2701", "15m", "2026-08-24 09:15:00")).toBe(true)
  })

  it("30m 茶歇分叉:跨茶歇桶为 10:00,下一轴点 10:45;墙钟 10:30/11:00 非法", () => {
    expect(isValidMinuteBarTime("ma2701", "30m", "2026-08-19 09:30:00")).toBe(true)
    expect(isValidMinuteBarTime("ma2701", "30m", "2026-08-19 10:00:00")).toBe(true)
    expect(isValidMinuteBarTime("ma2701", "30m", "2026-08-19 10:45:00")).toBe(true)
    expect(isValidMinuteBarTime("ma2701", "30m", "2026-08-19 11:15:00")).toBe(true)
    expect(isValidMinuteBarTime("ma2701", "30m", "2026-08-19 10:30:00")).toBe(false)
    expect(isValidMinuteBarTime("ma2701", "30m", "2026-08-19 11:00:00")).toBe(false)
  })

  it("本地周日幽灵桶在合并时被剔除,不再与服务端正常桶并存成双 K", () => {
    const local = [
      bar("2026-08-21 22:45:00", 2701),
      bar("2026-08-23 21:00:00", 2702), // 周日幽灵(旧日历周日晚误开市合成)
      bar("2026-08-23 22:30:00", 2703),
    ]
    const server = [
      bar("2026-08-21 22:45:00", 2701),
      bar("2026-08-24 09:00:00", 2704), // 服务端正常
    ]
    const merged = mergeServerBarsWithLocal(server, local, 2000, "ma2701", "15m")
    const times = merged.map((b) => b.time)
    expect(times).toEqual([
      "2026-08-21 22:45:00",
      "2026-08-24 09:00:00",
    ])
    expect(new Set(times).size).toBe(times.length) // 无重复
  })
})

describe("周末日历(后端 PR #179/#180 口径)", () => {
  it("周日全天休市(不存在周日夜盘)", () => {
    expect(isSymbolTradingMs("ma2701", t("2026-08-23 21:30"))).toBe(false)
    expect(isSymbolTradingMs("ma2701", t("2026-08-23 10:00"))).toBe(false)
  })

  it("au 跨午夜夜盘:周一凌晨无尾巴(周日晚无夜盘),周二凌晨有(周一夜盘延续)", () => {
    expect(isSymbolTradingMs("au2612", t("2026-08-24 01:00"))).toBe(false)
    expect(isSymbolTradingMs("au2612", t("2026-08-25 01:00"))).toBe(true)
  })

  it("au 周六凌晨(周五夜盘尾巴)可交易,周六白天休市;ma 周五夜盘中", () => {
    expect(isSymbolTradingMs("au2612", t("2026-08-22 01:00"))).toBe(true)
    expect(isSymbolTradingMs("au2612", t("2026-08-22 10:00"))).toBe(false)
    expect(isSymbolTradingMs("ma2701", t("2026-08-21 21:30"))).toBe(true)
  })

  it("isMinuteBarInSession 日历:周日/周一凌晨/周六白天非法", () => {
    expect(isMinuteBarInSession("2026-08-23 22:00:00")).toBe(false) // 周日夜
    expect(isMinuteBarInSession("2026-08-24 00:30:00")).toBe(false) // 周一凌晨
    expect(isMinuteBarInSession("2026-08-22 10:00:00")).toBe(false) // 周六日盘
    expect(isMinuteBarInSession("2026-08-22 00:30:00")).toBe(true) // 周六凌晨尾巴
    expect(isMinuteBarInSession("2026-08-21 22:00:00")).toBe(true) // 周五夜盘
    expect(isMinuteBarInSession("2026-08-25 00:30:00")).toBe(true) // 周二凌晨
  })
})
