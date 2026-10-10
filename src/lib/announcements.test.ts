import { beforeEach, describe, expect, it, vi } from "vitest"
import { announcementScope, isAnnouncementDismissed, setAnnouncementDismissed } from "./announcements"

describe("startup announcement preferences", () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  })
  it("suppresses only the checked publication and shows a new publication", () => {
    const scope = announcementScope("user-1", "https://server")
    expect(isAnnouncementDismissed(scope, "first")).toBe(false)
    expect(setAnnouncementDismissed(scope, "first", true)).toBe(true)
    expect(isAnnouncementDismissed(scope, "first")).toBe(true)
    expect(isAnnouncementDismissed(scope, "second")).toBe(false)
    setAnnouncementDismissed(scope, "second", false)
    expect(isAnnouncementDismissed(scope, "first")).toBe(true)
    setAnnouncementDismissed(scope, "first", false)
    expect(isAnnouncementDismissed(scope, "first")).toBe(false)
  })
  it("isolates users and servers and normalizes a trailing slash", () => {
    const scope = announcementScope("user-1", "https://server/")
    setAnnouncementDismissed(scope, "first", true)
    expect(isAnnouncementDismissed(announcementScope("user-1", "https://server"), "first")).toBe(true)
    expect(isAnnouncementDismissed(announcementScope("user-2", "https://server"), "first")).toBe(false)
    expect(isAnnouncementDismissed(announcementScope("user-1", "https://another"), "first")).toBe(false)
  })
  it("storage failures do not hide new announcements or crash", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw Error("storage disabled") }, setItem: () => { throw Error("storage disabled") } })
    expect(isAnnouncementDismissed("scope", "first")).toBe(false)
    expect(setAnnouncementDismissed("scope", "first", true)).toBe(false)
  })
})
