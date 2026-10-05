/**
 * K 线合成引擎 + 交易分钟轴 单元测试
 *
 * 时间约定与被测模块一致:「北京时间视为 UTC」的 fake ms。
 * 参考日:2026-08-19(周三)、2026-08-20(周四)、2026-08-21(周五)、2026-08-22(周六)。
 * 语义基准:backend/app/services/kline.py update_realtime_klines + session_profiles.py。
 */
import { describe, expect, it } from "vitest"
import {
  bjNowMs,
  getTradingDayMs,
  isMinuteBarInSession,
  isSymbolTradingMs,
  periodStartForProduct,
  wallClockBucketMs,
} from "@/lib/trading-sessions"
import { KlineEngine, type EngineKlineUpdate } from "@/lib/kline-engine"
import { mergeServerBarsWithLocal } from "@/lib/kline-cache"
import type { KlineBar } from "@/types"
import type { QuoteData } from "@/lib/websocket"

/** "2026-08-19 10:20[:30]" → fake-UTC ms(即北京时间墙钟) */
function t(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)!
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
}

let tickSeq = 0
function q(
  symbol: string,
  price: number,
  volume: number,
  extra: Partial<QuoteData> = {},
): QuoteData {
  tickSeq += 1
  return {
    symbol,
    last_price: price,
    volume,
    tick_time: `#${tickSeq}`,
    ...extra,
  } as unknown as QuoteData
}

function barsOf(updates: EngineKlineUpdate[], period: string) {
  return updates.filter((u) => u.period === period)
}

describe("交易分钟轴(后端 session_profiles 移植)", () => {
  it("RB 30m:小节休息内(10:20)仍属 10:00 桶", () => {
    expect(periodStartForProduct("RB", t("2026-08-19 10:20"), 30)).toBe(t("2026-08-19 10:00"))
  })

  it("RB 60m:午休后 13:35 的桶起点是 11:15(交易轴跨午休延续)", () => {
    expect(periodStartForProduct("RB", t("2026-08-19 13:35"), 60)).toBe(t("2026-08-19 11:15"))
  })

  it("AU 60m:夜盘 330 分钟 + 日盘 35 分钟 → 桶起点 09:30(夜盘余 30 分钟延续到日盘)", () => {
    expect(periodStartForProduct("AU", t("2026-08-19 09:35"), 60)).toBe(t("2026-08-19 09:30"))
  })

  it("墙钟兜底:10:07 的 5m 桶 → 10:05", () => {
    expect(wallClockBucketMs(t("2026-08-19 10:07"), 5)).toBe(t("2026-08-19 10:05"))
  })

  it("期货交易日:周五 21:30 归下周一;周五 10:00 归当日;周六凌晨归周一(与后端口径一致)", () => {
    expect(getTradingDayMs(t("2026-08-21 21:30"))).toBe(t("2026-08-24 00:00"))
    expect(getTradingDayMs(t("2026-08-21 10:00"))).toBe(t("2026-08-21 00:00"))
    expect(getTradingDayMs(t("2026-08-22 01:00"))).toBe(t("2026-08-24 00:00"))
  })

  it("交易时段判定:午休/小节休/周六白天/周日白天休,夜盘开", () => {
    expect(isSymbolTradingMs("rb2601", t("2026-08-19 10:10"))).toBe(true)
    expect(isSymbolTradingMs("rb2601", t("2026-08-19 10:20"))).toBe(false)
    expect(isSymbolTradingMs("rb2601", t("2026-08-19 12:00"))).toBe(false)
    expect(isSymbolTradingMs("rb2601", t("2026-08-22 12:00"))).toBe(false)
    expect(isSymbolTradingMs("rb2601", t("2026-08-23 12:00"))).toBe(false)
    expect(isSymbolTradingMs("rb2601", t("2026-08-19 21:30"))).toBe(true)
  })

  it("粗粒度时段:12:00 非交易,13:00/21:30 交易", () => {
    expect(isMinuteBarInSession("2026-08-19 12:00:00")).toBe(false)
    expect(isMinuteBarInSession("2026-08-19 13:00:00")).toBe(true)
    expect(isMinuteBarInSession("2026-08-19 21:30:00")).toBe(true)
  })
})

describe("K 线合成引擎", () => {
  it("bjNowMs 恒定领先真实时钟 8 小时(回归:曾在 UTC+8 机器上慢 8h 导致引擎全程误判休市)", () => {
    expect(Math.abs(bjNowMs() - Date.now() - 8 * 3600 * 1000)).toBeLessThan(2000)
  })

  it("首笔 tick 建桶:分钟级 open=首价/量=0,日线用交易所 OHLC", () => {
    const e = new KlineEngine()
    const out = e.ingestQuotes(
      [q("rb2601", 3500, 10000, {
        open_price: 3490, high_price: 3510, low_price: 3480, position: 123456,
      })],
      t("2026-08-19 10:00:30"),
    )
    const m1 = barsOf(out.updates, "1m")[0]
    expect(m1.bar.time).toBe("2026-08-19 10:00:00")
    expect(m1.bar.open).toBe(3500)
    expect(m1.bar.volume).toBe(0)
    const d = barsOf(out.updates, "1d")[0]
    expect(d.bar.time).toBe("2026-08-19")
    expect(d.bar.open).toBe(3490)
    expect(d.bar.high).toBe(3510)
    expect(d.bar.low).toBe(3480)
    expect(d.bar.volume).toBe(10000)
    expect(d.bar.open_interest).toBe(123456)
    // 6 个分钟周期（含 4 小时）+ 日线
    expect(new Set(out.updates.map((u) => u.period)).size).toBe(7)
  })

  it("同桶推进:close/high/low 跟 tick,量=周期内增量;1m 换桶后 5m 仍在同桶累计", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:00:30"))
    let out = e.ingestQuotes([q("rb2601", 3505, 10030)], t("2026-08-19 10:00:50"))
    const m1 = barsOf(out.updates, "1m")[0].bar
    expect(m1.close).toBe(3505)
    expect(m1.high).toBe(3505)
    expect(m1.volume).toBe(30)
    expect(m1.open).toBe(3500) // open 锁定

    out = e.ingestQuotes([q("rb2601", 3502, 10050)], t("2026-08-19 10:01:10"))
    const newM1 = barsOf(out.updates, "1m")[0].bar
    expect(newM1.time).toBe("2026-08-19 10:01:00")
    expect(newM1.open).toBe(3502)
    expect(newM1.volume).toBe(0)
    const m5 = barsOf(out.updates, "5m")[0].bar
    expect(m5.time).toBe("2026-08-19 10:00:00")
    expect(m5.volume).toBe(50)
  })

  it("无新 tick 的 quote 不产生任何推送(休盘静止 + 省渲染)", () => {
    const e = new KlineEngine()
    const quote = q("rb2601", 3500, 10000)
    e.ingestQuotes([quote], t("2026-08-19 10:00:30"))
    const same = q("rb2601", 3500, 10000)
    same.tick_time = quote.tick_time
    expect(e.ingestQuotes([same], t("2026-08-19 10:00:40")).updates.length).toBe(0)
  })

  it("累计量回退(跨交易日/重置):重新锚定基准,量从 0 计", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:05:10"))
    let out = e.ingestQuotes([q("rb2601", 3498, 9950)], t("2026-08-19 10:05:30"))
    let m1 = barsOf(out.updates, "1m")[0].bar
    expect(m1.volume).toBe(0)
    out = e.ingestQuotes([q("rb2601", 3499, 9960)], t("2026-08-19 10:05:50"))
    m1 = barsOf(out.updates, "1m")[0].bar
    expect(m1.volume).toBe(10)
  })

  it("夜盘 21:30 的日线归属下一交易日(周四)", () => {
    const e = new KlineEngine()
    const out = e.ingestQuotes(
      [q("rb2601", 3500, 500, { open_price: 3495, high_price: 3502, low_price: 3491 })],
      t("2026-08-19 21:30"),
    )
    expect(barsOf(out.updates, "1d")[0].bar.time).toBe("2026-08-20")
    expect(barsOf(out.updates, "1m")[0].bar.time).toBe("2026-08-19 21:30:00")
  })

  it("休市时段不产幽灵分钟 bar(18:30 仅日线可更新)", () => {
    const e = new KlineEngine()
    const out = e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 18:30"))
    expect(barsOf(out.updates, "1m").length).toBe(0)
    expect(barsOf(out.updates, "5m").length + barsOf(out.updates, "15m").length + barsOf(out.updates, "30m").length + barsOf(out.updates, "60m").length).toBe(0)
    expect(barsOf(out.updates, "1d").length).toBe(1)
  })

  it("午休保留跨休盘长周期状态:13:00 不更新,13:35 继续同一根 60m(11:15 起)", () => {
    const e = new KlineEngine()
    // 11:20 建桶(60m 桶起点 11:15)
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 11:20"))
    // 午休 13:00:休市但桶未封 → 状态保留,无推送
    const lunch = e.ingestQuotes([q("rb2601", 3501, 10010)], t("2026-08-19 13:00"))
    expect(barsOf(lunch.updates, "60m").length).toBe(0)
    // 13:35 复盘:60m 仍在 11:15 桶,继续累计
    const out = e.ingestQuotes([q("rb2601", 3502, 10020)], t("2026-08-19 13:35"))
    const m60 = barsOf(out.updates, "60m")[0].bar
    expect(m60.time).toBe("2026-08-19 11:15:00")
    expect(m60.close).toBe(3502)
  })
})

describe("服务端 kline 采纳(种子/追赶)", () => {
  const serverBar = {
    symbol: "rb2601", period: "5m",
    bar: { time: "2026-08-19 10:10:00", open: 3500, high: 3508, low: 3495, close: 3505, volume: 150 },
  }

  it("无本地状态 → 采纳;下一笔 quote 重锚后继续本地累计", () => {
    const e = new KlineEngine()
    const adopted = e.ingestServerBars([serverBar], t("2026-08-19 10:10:05"))
    expect(adopted.length).toBe(1)
    // quote 进来(同桶):增量基准 = 20000 - 150 = 19850 → 量 = 150
    const out = e.ingestQuotes([q("rb2601", 3506, 20000)], t("2026-08-19 10:10:30"))
    const m5 = barsOf(out.updates, "5m")[0].bar
    expect(m5.time).toBe("2026-08-19 10:10:00")
    expect(m5.volume).toBe(150)
    expect(m5.close).toBe(3506)
  })

  it("同桶:本地更新鲜,忽略服务端;服务端落后:忽略", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:10:30"))
    const same = e.ingestServerBars([serverBar], t("2026-08-19 10:10:31"))
    expect(same.length).toBe(0)
    const behind = e.ingestServerBars([{
      ...serverBar, bar: { ...serverBar.bar, time: "2026-08-19 10:05:00" },
    }], t("2026-08-19 10:10:32"))
    expect(behind.length).toBe(0)
  })

  it("服务端领先(交易轴修正/快照)→ 整体采纳", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:10:30"))
    const ahead = e.ingestServerBars([{
      ...serverBar, bar: { ...serverBar.bar, time: "2026-08-19 10:15:00" },
    }], t("2026-08-19 10:15:05"))
    expect(ahead.length).toBe(1)
    expect(ahead[0].bar.time).toBe("2026-08-19 10:15:00")
  })

  it("reset 后状态清空,服务端快照可重新播种", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:10:30"))
    e.reset()
    const adopted = e.ingestServerBars([serverBar], t("2026-08-19 10:10:35"))
    expect(adopted.length).toBe(1)
  })
})

describe("本地优先:收盘 bar 落地", () => {
  it("1m 换桶时交出上一根最终态(close/high/low/量为最后状态);同桶的更长周期不重复交出", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:00:30"))
    e.ingestQuotes([q("rb2601", 3505, 10030)], t("2026-08-19 10:00:50"))
    const res = e.ingestQuotes([q("rb2601", 3502, 10050)], t("2026-08-19 10:01:10"))
    const closed1m = res.closed.find((c) => c.period === "1m")
    expect(closed1m).toBeDefined()
    expect(closed1m!.bar.time).toBe("2026-08-19 10:00:00")
    expect(closed1m!.bar.close).toBe(3505)
    expect(closed1m!.bar.high).toBe(3505)
    expect(closed1m!.bar.volume).toBe(30)
    // 5m 仍在同桶,不该出现在 closed 里
    expect(res.closed.find((c) => c.period === "5m")).toBeUndefined()
  })

  it("换交易日时交出上一交易日日线最终态", () => {
    const e = new KlineEngine()
    e.ingestQuotes(
      [q("rb2601", 3500, 10000, { open_price: 3490, high_price: 3510, low_price: 3480 })],
      t("2026-08-19 14:50"),
    )
    const res = e.ingestQuotes(
      [q("rb2601", 3495, 300, { open_price: 3492, high_price: 3498, low_price: 3490 })],
      t("2026-08-19 21:30"),
    )
    const closedD = res.closed.find((c) => c.period === "1d")
    expect(closedD).toBeDefined()
    expect(closedD!.bar.time).toBe("2026-08-19")
    expect(closedD!.bar.close).toBe(3500)
    expect(closedD!.bar.high).toBe(3510)
  })

  it("同桶推进不产生 closed", () => {
    const e = new KlineEngine()
    e.ingestQuotes([q("rb2601", 3500, 10000)], t("2026-08-19 10:00:30"))
    const res = e.ingestQuotes([q("rb2601", 3505, 10030)], t("2026-08-19 10:00:50"))
    expect(res.closed.length).toBe(0)
  })
})

describe("本地优先:服务端历史合并(并集,任何一侧的 bar 都不丢)", () => {
  const b = (time: string, close = 100) =>
    ({ time, open: close, high: close, low: close, close, volume: 1 }) as KlineBar

  it("本地为空 → 原样返回服务端;服务端为空 → 保留本地", () => {
    const server = [b("2026-08-19 10:00:00"), b("2026-08-19 10:01:00")]
    expect(mergeServerBarsWithLocal(server, [])).toEqual(server)
    const local = [b("2026-08-19 10:01:00", 102)]
    expect(mergeServerBarsWithLocal([], local)).toEqual(local)
  })

  it("服务端返回变短(缺段)→ 本地已有的 bar 不丢,按时间排序并集", () => {
    const server = [b("2026-08-19 10:04:00", 104)]
    const local = [b("2026-08-19 10:00:00"), b("2026-08-19 10:01:00"), b("2026-08-19 10:03:00", 103)]
    const merged = mergeServerBarsWithLocal(server, local)
    expect(merged.map((x) => x.time)).toEqual([
      "2026-08-19 10:00:00",
      "2026-08-19 10:01:00",
      "2026-08-19 10:03:00",
      "2026-08-19 10:04:00",
    ])
  })

  it("同时间以服务端为准(TqSdk 修正权威值)", () => {
    const server = [b("2026-08-19 10:01:00", 999)]
    const local = [b("2026-08-19 10:01:00", 102)]
    expect(mergeServerBarsWithLocal(server, local)[0].close).toBe(999)
  })

  it("超出 cap → 丢弃最旧的", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => b(`2026-08-19 10:${String(i).padStart(2, "0")}:00`))
    const merged = mergeServerBarsWithLocal(mk(30), mk(30), 20)
    expect(merged.length).toBe(20)
  })

  it("旧口径(墙钟语义)bar 被交易轴校验剔除,不再与新口径并存成双 K", () => {
    // 60m 合法轴桶:10:00/11:15/14:15/21:00/22:00;旧墙钟桶 13:00/14:00 非法
    const server = [b("2026-08-19 11:15:00", 200), b("2026-08-19 14:15:00"), b("2026-08-19 21:00:00")]
    const local = [b("2026-08-19 10:00:00", 110), b("2026-08-19 13:00:00", 150), b("2026-08-19 14:00:00", 210)]
    const merged = mergeServerBarsWithLocal(server, local, 2000, "rb2601", "60m")
    expect(merged.map((x) => x.time)).toEqual([
      "2026-08-19 10:00:00",
      "2026-08-19 11:15:00",
      "2026-08-19 14:15:00",
      "2026-08-19 21:00:00",
    ])
    // 5m:小节休息里的墙钟桶 10:20 非法(axis=10:15)
    const m5 = mergeServerBarsWithLocal([b("2026-08-19 10:15:00")], [b("2026-08-19 10:20:00")], 2000, "rb2601", "5m")
    expect(m5.map((x) => x.time)).toEqual(["2026-08-19 10:15:00"])
    // 30m:13:45 是合法轴桶
    const m30 = mergeServerBarsWithLocal([], [b("2026-08-19 13:45:00")], 2000, "rb2601", "30m")
    expect(m30.length).toBe(1)
    // 1m 任意分钟合法
    const m1 = mergeServerBarsWithLocal([], [b("2026-08-19 11:30:00")], 2000, "rb2601", "1m")
    expect(m1.length).toBe(1)
  })
})

describe("未来时间戳护栏", () => {
  it("服务端 bar 时间超出当前 2 个周期 → 拒绝采纳(防脏数据污染)", () => {
    const e = new KlineEngine()
    // now=10:10:30,5m 当前桶 10:10,容忍至 10:20;11:00 属未来 → 拒绝
    const far = e.ingestServerBars([{
      symbol: "rb2601", period: "5m",
      bar: { time: "2026-08-19 11:00:00", open: 3500, high: 3500, low: 3500, close: 3500, volume: 10 },
    }], t("2026-08-19 10:10:30"))
    expect(far.length).toBe(0)
  })

  it("略领先(时钟差/桶边界,≤2 周期)→ 仍可采纳", () => {
    const e = new KlineEngine()
    const near = e.ingestServerBars([{
      symbol: "rb2601", period: "5m",
      bar: { time: "2026-08-19 10:15:00", open: 3500, high: 3500, low: 3500, close: 3500, volume: 10 },
    }], t("2026-08-19 10:10:30"))
    expect(near.length).toBe(1)
  })

  it("日线未来超过 2 天 → 拒绝", () => {
    const e = new KlineEngine()
    const far = e.ingestServerBars([{
      symbol: "rb2601", period: "1d",
      bar: { time: "2026-08-25", open: 3500, high: 3500, low: 3500, close: 3500, volume: 10 },
    }], t("2026-08-19 10:10:30"))
    expect(far.length).toBe(0)
  })
})
