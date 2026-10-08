import { beforeEach, expect, it } from "vitest"
import { loadServers, saveServer, deleteServer, selectServer, normalizeServerBase } from "./server-profiles"

const data = new Map<string, string>()
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
beforeEach(() => data.clear())

it("migrates the current custom endpoint and persists an editable server list", () => {
  storage.setItem("atd_desktop_server", "http://localhost:8002")
  const list = loadServers(storage)
  expect(list.some(s => s.base === "http://localhost:8002")).toBe(true)
  const added = saveServer(list, { id: "custom", name: "测试", base: "example.com/" }, storage)
  const edited = saveServer(added, { id: "custom", name: "备用", base: "http://example.com:8002" }, storage)
  expect(loadServers(storage).find(s => s.id === "custom")?.name).toBe("备用")
  expect(deleteServer(edited, "custom", storage).some(s => s.id === "custom")).toBe(false)
})

it("isolates tokens and remembered passwords and restores each server's session", () => {
  storage.setItem("atd_desktop_server", "https://a.example")
  storage.setItem("access_token", "a-token")
  storage.setItem("qihuo_login_password", "a-password")
  selectServer("https://a.example", "https://b.example", storage)
  expect(storage.getItem("access_token")).toBeNull()
  expect(storage.getItem("qihuo_login_password")).toBeNull()
  storage.setItem("access_token", "b-token")
  selectServer("https://b.example", "https://a.example", storage)
  expect(storage.getItem("access_token")).toBe("a-token")
  expect(storage.getItem("qihuo_login_password")).toBe("a-password")
  expect(storage.getItem("atd_desktop_server")).toBe("https://a.example")
})

it("rejects invalid endpoints and duplicate addresses", () => {
  expect(normalizeServerBase("example.com/")).toBe("https://example.com")
  for (const base of ["", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com?q=x"]) {
    expect(() => normalizeServerBase(base)).toThrow()
  }
  const list = loadServers(storage)
  expect(() => saveServer(list, { id: "dupe", name: "重复", base: list[0].base }, storage)).toThrow()
})
