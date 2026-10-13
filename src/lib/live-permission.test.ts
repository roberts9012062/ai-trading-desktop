import { describe, expect, it } from "vitest"
import { canConnectExchange, isRealTradingProtection, REAL_TRADING_PROTECTION_MESSAGE } from "./live-permission"

describe("real-money connection protection", () => {
  it("requires an explicit grant for real money while leaving demo available", () => {
    expect(canConnectExchange(false, false)).toBe(false)
    expect(canConnectExchange(false, true)).toBe(true)
    expect(canConnectExchange(true, false)).toBe(true)
  })
  it("recognizes a current server denial after an old client grant", () => {
    expect(isRealTradingProtection(new Error(REAL_TRADING_PROTECTION_MESSAGE))).toBe(true)
    expect(isRealTradingProtection(new Error("network unavailable"))).toBe(false)
  })
})
