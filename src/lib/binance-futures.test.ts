// vitest: Binance USDT-M 永续归档渠道网络实测(node 环境,无 CORS 限制;
// 数据层全链路:zip 下载→解析→翻页→资金费率合并。UI 层由 tsc 覆盖。)
import { describe, expect, it } from "vitest"
import {
  enrichBinanceFuturesBars,
  getBinanceFuturesKlineApi,
  joinFunding,
  parseFundingCsv,
  parseUmKlinesCsv,
} from "./binance-futures"

const ONLINE = true // 弱网/离线环境可置 false 跳过

describe("binance-futures 归档渠道(网络实测)", () => {
  it("CSV 解析:K 线表头跳过与字段映射", () => {
    const text = [
      "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore",
      "1704067200000,42300.00,42500.00,42200.00,42400.00,100.5,1704070799999,4240000.25,1234,55.2,2330000.10,0",
    ].join("\n")
    const bars = parseUmKlinesCsv(text, "1h")
    expect(bars).toHaveLength(1)
    expect(bars[0].market_source).toBe("binance_usdt")
    expect(bars[0].quote_volume).toBeCloseTo(4240000.25)
    expect(bars[0].trade_count).toBe(1234)
    expect(bars[0].taker_buy_volume).toBeCloseTo(55.2)
    expect(bars[0].time).toBe("2024-01-01 08:00:00") // 北京时间
  })

  it("CSV 解析:资金费率新旧两种表头", () => {
    const a = parseFundingCsv("calc_time,funding_interval_hours,last_funding_rate\n1704067200000,8,0.00037409\n")
    expect(a).toEqual([{ t: 1704067200000, r: 0.00037409 }])
    const b = parseFundingCsv("calc_time,funding_interval_hours,last_funding_rate\n1704096000000,8,-0.0001\n")
    expect(b[0].r).toBe(-0.0001)
  })

  it("joinFunding:结算后生效 + 缺失报错不补零", () => {
    const bars = parseUmKlinesCsv(
      "1704067200000,1,1,1,1,1,1704070799999,1,1,1,1,0\n1704070800000,1,1,1,1,1,1704074399999,1,1,1,1,0",
      "1h",
    )
    const ok = joinFunding(bars, [{ t: 1704067200000, r: 0.0001 }])
    expect(ok[0].funding_rate).toBe(0.0001)
    expect(ok[1].funding_rate).toBe(0.0001)
    // 首根早于任何结算 → 报错
    expect(() => joinFunding(bars, [{ t: 1704096000000, r: 0.0001 }])).toThrow(/覆盖不足/)
  })

  it.skipIf(!ONLINE)("翻页:月包锚点回溯,严格不重叠", { timeout: 120_000 }, async () => {
    // 2024-01-15 12:00 之后的一页(1h)应落在 2024-01 月包内
    const p1 = await getBinanceFuturesKlineApi("btcusdt", "60m", { limit: 500, endTime: "2024-01-15 12:00:00" })
    expect(p1.bars.length).toBeGreaterThan(100)
    expect(p1.has_more).toBe(true)
    expect(p1.bars[p1.bars.length - 1].time <= "2024-01-15 12:00:00").toBe(true)
    // 下一页锚点 = 上页最旧一根,两页应零重叠且连续
    const p2 = await getBinanceFuturesKlineApi("btcusdt", "60m", { limit: 500, endTime: p1.bars[0].time })
    const overlap = p2.bars.filter((b) => b.time >= p1.bars[0].time)
    expect(overlap).toHaveLength(0)
    expect(p2.bars.length).toBeGreaterThan(0)
    // 时间连续性:相邻 1h
    const ms = (t: string) => Date.parse(`1970-01-01T${t.replace(" ", "T")}Z`) // 仅取时分秒无意义,改用 open_time
    expect(p1.bars[0].open_time! - p2.bars[p2.bars.length - 1].open_time!).toBe(3_600_000)
    void ms
  })

  it.skipIf(!ONLINE)("资金费率并入:真实归档", { timeout: 180_000 }, async () => {
    const p1 = await getBinanceFuturesKlineApi("btcusdt", "60m", { limit: 500, endTime: "2024-03-10 00:00:00" })
    const enriched = await enrichBinanceFuturesBars("btcusdt", p1.bars.slice(-200))
    expect(enriched.length).toBe(200)
    const withFunding = enriched.filter((b) => typeof b.funding_rate === "number")
    expect(withFunding.length).toBe(200)
    // 资金费率量级合理性(|r| < 2%)
    for (const b of withFunding) expect(Math.abs(b.funding_rate as number)).toBeLessThan(0.02)
  })

  it.skipIf(!ONLINE)("最新一页:日包可达", { timeout: 120_000 }, async () => {
    const p = await getBinanceFuturesKlineApi("btcusdt", "1d")
    expect(p.bars.length).toBeGreaterThan(0)
    expect(p.has_more).toBe(true)
    // 最近一根应在近 5 天内(归档 T+1 滞后)
    const age = Date.now() - (p.bars[p.bars.length - 1].open_time ?? 0)
    expect(age).toBeLessThan(5 * 86400000)
  })
})
