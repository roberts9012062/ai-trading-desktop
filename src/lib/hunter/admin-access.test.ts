import { afterEach, expect, it, vi } from "vitest"
import { useAuthStore } from "@/stores/auth"
import { useHunterStore } from "@/stores/hunter"
import { hunterApi } from "./api"
import { startHunterRuntime } from "./scanner"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState({ user: null }); useHunterStore.getState().reset() })

it("ordinary users never fetch hunter APIs or acquire scanner ownership", async () => {
  useAuthStore.setState({ user: { id: "user", role: "user" } as never })
  const fetch = vi.fn(); const lock = vi.fn()
  vi.stubGlobal("fetch", fetch)
  vi.stubGlobal("navigator", { locks: { request: lock } })
  useHunterStore.setState({ groups: [{ id: "stale-admin-group" }] as never })
  const stop = startHunterRuntime()
  await expect(hunterApi.list()).rejects.toThrow("仅向管理员")
  await expect(hunterApi.capabilities()).rejects.toThrow("仅向管理员")
  expect(useHunterStore.getState().groups).toEqual([])
  expect(fetch).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled()
  stop()
})

it("administrators keep the authenticated hunter API", async () => {
  useAuthStore.setState({ user: { id: "admin", role: "admin" } as never })
  vi.stubGlobal("localStorage", { getItem: () => "test-token" })
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
  vi.stubGlobal("fetch", fetch)
  expect(await hunterApi.list()).toEqual([])
  expect(fetch).toHaveBeenCalledOnce()
})
