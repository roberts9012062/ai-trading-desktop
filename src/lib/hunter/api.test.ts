import { expect, it } from "vitest"
import { canStartHunter, hunterAccountLabel } from "./api"

it("allows an OKX demo API login even though the platform calls its mode live", () => {
  expect(canStartHunter({ trading_mode: "live", execution_mode: "okx_demo", can_start: true, live_qualified: false, reason: "" })).toBe(true)
  expect(hunterAccountLabel("okx_demo")).toBe("OKX API 模拟盘")
})

it("uses server execution capability rather than an unverified profit qualification", () => {
  expect(canStartHunter({ trading_mode: "live", execution_mode: "okx_live", can_start: true, live_qualified: false, reason: "" })).toBe(true)
  expect(hunterAccountLabel("okx_live")).toBe("OKX API 实盘")
  expect(canStartHunter({ trading_mode: "live", can_start: false, live_qualified: true, reason: "API 未配置" })).toBe(false)
})

it("keeps old server paper accounts working without enabling an unsupported API path", () => {
  expect(canStartHunter({ trading_mode: "virtual", live_qualified: false, reason: "" })).toBe(true)
  expect(canStartHunter({ trading_mode: "live", live_qualified: false, reason: "" })).toBe(false)
})
