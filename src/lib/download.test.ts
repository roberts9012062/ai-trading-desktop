import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { downloadAuthenticatedFile } from "./download"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
const config = JSON.stringify({ format: "cyclepilot-strategies", version: 1, items: [{ kind: "task", config: { name: "雪崩-15分钟", leverage: 7 } }] })
const fetcher = vi.fn()
const createElement = vi.fn()
beforeEach(() => {
  invoke.mockReset().mockResolvedValue("D:\\导出\\任务.json")
  fetcher.mockReset().mockImplementation(async () => new Response(config, { headers: { "Content-Disposition": 'attachment; filename="task.json"' } }))
  createElement.mockReset().mockReturnValue({ click: vi.fn(), remove: vi.fn() })
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __QH_API_BASE__: "https://b.00n.top", localStorage: { getItem: () => "test-token" } })
  vi.stubGlobal("document", { createElement, body: { appendChild: vi.fn() } })
  vi.stubGlobal("fetch", fetcher)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("saves authenticated export bytes through the native dialog instead of a Blob anchor", async () => {
  const result = await downloadAuthenticatedFile("/api/strategy-transfer/tasks/test/export", "fallback.json")
  expect(fetcher.mock.calls[0][0]).toBe("https://b.00n.top/api/strategy-transfer/tasks/test/export")
  expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer test-token" })
  expect(invoke).toHaveBeenCalledWith("desktop_save_export", { fileName: "task.json", data: Array.from(new TextEncoder().encode(config)) })
  expect(createElement).not.toHaveBeenCalled()
  expect(result).toEqual({ status: "saved", path: "D:\\导出\\任务.json" })
})
it("treats cancelling the native save dialog as cancellation, not successful export", async () => {
  invoke.mockResolvedValueOnce(null)
  expect(await downloadAuthenticatedFile("https://b.00n.top/api/test", "config.json")).toEqual({ status: "cancelled" })
})
it("propagates write failures so the UI can display them", async () => {
  invoke.mockRejectedValueOnce("保存文件失败：磁盘空间不足")
  await expect(downloadAuthenticatedFile("/api/test", "config.json")).rejects.toThrow("磁盘空间不足")
})
it("does not open the save dialog on server errors or malformed success responses", async () => {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "任务不存在" }), { status: 404 }))
  await expect(downloadAuthenticatedFile("/api/test", "config.json")).rejects.toThrow("任务不存在")
  fetcher.mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }))
  await expect(downloadAuthenticatedFile("/api/test", "config.json")).rejects.toThrow("文件")
  expect(invoke).not.toHaveBeenCalled()
})
it("honors UTF-8 filenames and rejects cross-origin credential forwarding", async () => {
  fetcher.mockResolvedValueOnce(new Response(config, { headers: { "Content-Disposition": "attachment; filename*=UTF-8''%E4%BB%BB%E5%8A%A1.json" } }))
  await downloadAuthenticatedFile("/api/test", "config.json")
  expect(invoke.mock.calls[0][1].fileName).toBe("任务.json")
  fetcher.mockClear()
  await expect(downloadAuthenticatedFile("https://untrusted.example/api/test", "config.json")).rejects.toThrow("服务器")
  expect(fetcher).not.toHaveBeenCalled()
})
it("keeps browser downloads alive until the browser has consumed the object URL", async () => {
  vi.stubGlobal("window", { localStorage: { getItem: () => "test-token" } })
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  expect(await downloadAuthenticatedFile("/api/test", "config.json")).toEqual({ status: "downloaded", name: "task.json" })
  expect(createElement).toHaveBeenCalledWith("a")
  expect(revoke).not.toHaveBeenCalled()
})
