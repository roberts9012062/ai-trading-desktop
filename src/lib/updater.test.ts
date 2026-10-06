import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopUpdate } from "./native-updater"
const { checkChannel } = vi.hoisted(() => ({ checkChannel: vi.fn() }))
vi.mock("./native-updater", () => ({ checkChannel }))
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn(), warn: vi.fn() }))
import { checkForUpdate, downloadUpdate, setUpdateProxy } from "./updater"
import { GITHUB_UPDATE_PROXIES, manifestEndpoint, updateChannels } from "./update-channels"
import { DEFAULT_INDICATOR_CONFIG } from "@/types/indicator"
import { normalizeIndicatorConfig } from "@/stores/indicator-config-io"

function update(version = "0.2.117", signature = "signed"): DesktopUpdate {
  return { currentVersion: "0.2.116", version, rawJson: { platforms: { "windows-x86_64": { signature, url: "public-asset" } } }, download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
}
beforeEach(() => {
  checkChannel.mockReset()
  const entries = new Map<string, string>()
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
  vi.stubGlobal("localStorage", { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) })
})
describe("public update channel pool", () => {
  it("uses verified mirrors then direct; retains custom proxy priority", () => {
    expect(updateChannels(undefined)).toEqual([...GITHUB_UPDATE_PROXIES.map(mirror => ({ mirror })), {}])
    expect(updateChannels("http://127.0.0.1:7890")[0]).toEqual({ proxy: "http://127.0.0.1:7890" })
    expect(manifestEndpoint({ mirror: GITHUB_UPDATE_PROXIES[0] }, 123)).toContain("latest.json?atd_check=123")
  })
  it("switches after a failed check and keeps explicit direct mode", async () => {
    checkChannel.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(null)
    expect(await checkForUpdate()).toBeNull()
    expect(checkChannel.mock.calls.map(call => call[0])).toEqual(updateChannels(undefined).slice(0, 2))
    checkChannel.mockClear(); setUpdateProxy("")
    checkChannel.mockResolvedValue(null)
    await checkForUpdate(); expect(checkChannel).toHaveBeenCalledExactlyOnceWith({})
  })
  it("restarts download progress after failure and installs the successful resource", async () => {
    const first = update(), second = update()
    vi.mocked(first.download).mockImplementation(async cb => { cb?.({ event: "Progress", data: { chunkLength: 80 } }); throw new Error("interrupted") })
    vi.mocked(second.download).mockImplementation(async cb => { cb?.({ event: "Started", data: { contentLength: 100 } }); cb?.({ event: "Progress", data: { chunkLength: 20 } }); cb?.({ event: "Finished" }) })
    checkChannel.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const found = await checkForUpdate(); const progress: number[] = []
    await downloadUpdate(found!, event => progress.push(event.downloaded))
    expect(progress).toEqual([0, 80, 0, 0, 20, 100])
    expect(first.close).toHaveBeenCalledOnce()
    await found!.install(); expect(second.install).toHaveBeenCalledOnce(); expect(first.install).not.toHaveBeenCalled()
  })
  it("skips inconsistent signatures and falls through to a valid channel", async () => {
    const first = update(), wrong = update("0.2.117", "tampered"), valid = update()
    vi.mocked(first.download).mockRejectedValue(new Error("signature mismatch"))
    checkChannel.mockResolvedValueOnce(first).mockResolvedValueOnce(wrong).mockResolvedValueOnce(valid)
    const found = await checkForUpdate(); await found!.download()
    expect(wrong.download).not.toHaveBeenCalled(); expect(wrong.close).toHaveBeenCalledOnce()
    expect(valid.download).toHaveBeenCalledOnce()
  })
  it("never installs when every download fails", async () => {
    const resources = Array.from({ length: 4 }, () => update())
    for (const resource of resources) { vi.mocked(resource.download).mockRejectedValue(new Error("unavailable")); checkChannel.mockResolvedValueOnce(resource) }
    const found = await checkForUpdate()
    await expect(found!.download()).rejects.toThrow("unavailable")
    for (const resource of resources) expect(resource.install).not.toHaveBeenCalled()
  })
})
describe("default swing display", () => {
  it("enables the default and respects an explicitly saved disabled choice", () => {
    expect(normalizeIndicatorConfig(null).pivot.enabled).toBe(true)
    expect(normalizeIndicatorConfig({ ...DEFAULT_INDICATOR_CONFIG, pivot: { ...DEFAULT_INDICATOR_CONFIG.pivot, enabled: false } }).pivot.enabled).toBe(false)
  })
})
