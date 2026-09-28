import { describe, expect, it, vi } from "vitest"
const invoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }))

describe("Native launcher", () => {
  it("rejects invalid ports from a sidecar startup response", async () => {
    invoke.mockResolvedValue({ port: 0, token: "secret", pid: 1 })
    const { launchNativeEngine } = await import("./launcher")
    await expect(launchNativeEngine()).rejects.toThrow(/握手/)
  })
  it("passes only the approved precision choice to the Rust command", async () => {
    invoke.mockResolvedValue({ port: 12345, token: "a".repeat(32), pid: 9 })
    const { launchNativeEngine, stopNativeEngine } = await import("./launcher")
    await launchNativeEngine({ precision: "f64" })
    expect(invoke).toHaveBeenLastCalledWith("native_engine_spawn", { precision: "f64" })
    await stopNativeEngine()
    expect(invoke).toHaveBeenLastCalledWith("native_engine_kill")
  })
})
