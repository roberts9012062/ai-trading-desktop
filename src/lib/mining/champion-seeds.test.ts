import { describe, expect, it } from "vitest"
import { championSeedsFor, CHAMPION_SEED_LIBRARY } from "./champion-seeds"
import { gpuOpSets, slowBiasedOpSets } from "./gpu/gp"
import { OPS } from "./gpu/tokens"

describe("championSeedsFor", () => {
  it("精确命中:同币种同周期返回该组合的种子", () => {
    const pick = championSeedsFor("ADAUSDT", "30m")
    expect(pick.seeds.length).toBe(2)
    expect(pick.seeds.every(s => s.symbol === "ADAUSDT" && s.timeframe === "30m")).toBe(true)
  })

  it("同周期跨币:无同币种子时返回同周期去重种子", () => {
    const pick = championSeedsFor("ETHUSDT", "30m")
    expect(pick.seeds.length).toBeGreaterThan(0)
    expect(pick.seeds.some(s => s.symbol === "ETHUSDT")).toBe(false)
    expect(pick.note).toContain("同周期跨币")
  })

  it("跨周期迁移:未知周期返回全库去重种子", () => {
    const pick = championSeedsFor("ETHUSDT", "15m")
    expect(pick.seeds.length).toBeGreaterThan(0)
    expect(pick.note).toContain("跨周期")
  })

  it("同 token 跨币种子去重", () => {
    const pick = championSeedsFor("DOGEUSDT", "30m")
    const keys = pick.seeds.map(s => s.tokens.join(","))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("种子 token 均为合法编码(特征<64,算子≥64)", () => {
    for (const seed of CHAMPION_SEED_LIBRARY) {
      expect(seed.tokens.length).toBeGreaterThan(0)
      for (const t of seed.tokens) expect(Number.isInteger(t)).toBe(true)
    }
  })
})

describe("slowBiasedOpSets", () => {
  it("长周期(≥30m)原样返回", () => {
    const base = gpuOpSets(true)
    for (const tf of ["30m", "60m", "1d"]) {
      const biased = slowBiasedOpSets(base.opOne, base.opTwo, tf)
      expect(biased.opOne).toEqual(base.opOne)
      expect(biased.opTwo).toEqual(base.opTwo)
    }
  })

  it("短周期加权慢算子:慢算子计数增加,快算子不变", () => {
    const base = gpuOpSets(true)
    const biased = slowBiasedOpSets(base.opOne, base.opTwo, "1m")
    const count = (arr: number[], v: number) => arr.filter(x => x === v).length
    // TS_MA_60(30)/TS_ZSCORE_120(49)/LAG_5(28) 是慢算子且在 GPU 集内,应 ×(1+3)
    for (const slow of [30, 49, 28]) {
      expect(base.opOne).toContain(slow)
      expect(count(biased.opOne, slow)).toBe(count(base.opOne, slow) * 4)
    }
    // DELTA_1(idx 24)/TS_MA_5(idx 13) 是快算子,不加权
    expect(count(biased.opOne, 24)).toBe(count(base.opOne, 24))
    expect(count(biased.opOne, 13)).toBe(count(base.opOne, 13))
    // 加权不引入新算子 id
    for (const v of biased.opOne) expect(base.opOne).toContain(v)
    for (const v of biased.opTwo) expect(base.opTwo).toContain(v)
  })

  it("15m 权重为 2 档", () => {
    const base = gpuOpSets(true)
    const biased = slowBiasedOpSets(base.opOne, base.opTwo, "15m")
    const count = (arr: number[], v: number) => arr.filter(x => x === v).length
    expect(count(biased.opOne, 30)).toBe(count(base.opOne, 30) * 3)
  })

  it("未知/缺省周期不偏置", () => {
    const base = gpuOpSets(true)
    const a = slowBiasedOpSets(base.opOne, base.opTwo, undefined)
    const b = slowBiasedOpSets(base.opOne, base.opTwo, "2h")
    expect(a.opOne).toEqual(base.opOne)
    expect(b.opOne).toEqual(base.opOne)
  })

  it("OPS 名称与内核 OPS_CONFIG 慢算子口径抽查一致", () => {
    // 慢口径:EMA/DECAY/LAG/CORR/SNR 族 + win>=60/n>=24 + TS_MA win>=20
    expect(OPS[30].name).toBe("TS_MA_60")
    expect(OPS[49].name).toBe("TS_ZSCORE_120")
    expect(OPS[28].name).toBe("LAG_5")
    expect(OPS[24].name).toBe("DELTA_1") // 快算子(非慢)
    expect(OPS[13].name).toBe("TS_MA_5") // 快算子(win<20)
  })
})
