import { afterEach, expect, it, vi } from "vitest"
import { useAuthStore } from "@/stores/auth"
import { useHunterStore } from "@/stores/hunter"
import { hunterApi } from "./api"
import { startHunterRuntime } from "./scanner"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useAuthStore.setState({ user: null }); useHunterStore.getState().reset() })

it.each(['user','admin'])("%s cannot fetch deferred APIs or acquire scanner ownership", async (role) => {
  useAuthStore.setState({ user: { id: role, role } as never })
  const fetch = vi.fn(); const lock = vi.fn()
  vi.stubGlobal("fetch", fetch)
  vi.stubGlobal("navigator", { locks: { request: lock } })
  useHunterStore.setState({ groups: [{ id: "stale-admin-group" }] as never })
  const stop = startHunterRuntime()
  await expect(hunterApi.list()).rejects.toThrow("暂未开放")
  await expect(hunterApi.capabilities()).rejects.toThrow("暂未开放")
  expect(useHunterStore.getState().groups).toEqual([])
  expect(fetch).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled()
  stop()
})
