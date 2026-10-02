import { afterEach, describe, expect, it, vi } from "vitest"
import {
  aggregateDailyPnl,
  dayKeyLocal,
  fetchOkxBillsSince,
  loadLocalOkxCredentials,
  loadOkxDailyCache,
  saveLocalOkxCredentials,
  saveOkxDailyCache,
  type OkxBill,
} from "./okx-direct"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  } as Storage
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe("okx-direct local aggregation", () => {
  it("buckets bills into local calendar days with pnl+fee+funding", () => {
    const base = new Date(2026, 9, 2, 9, 30).getTime()
    const bills: OkxBill[] = [
      { billId: "1", type: "2", ts: String(base), pnl: "100", fee: "-2", fundingFee: "" },
      { billId: "2", type: "2", ts: String(base + 3_600_000), pnl: "-40", fee: "-1", fundingFee: "-0.5" },
      // 纯转账不产生盈亏，应被跳过
      { billId: "3", type: "1", ts: String(base + 7_200_000), pnl: "9999", fee: "0", fundingFee: "" },
      // 资金费账单：无 pnl/fee，只有 fundingFee
      { billId: "4", type: "6", ts: String(base + 86_400_000), pnl: "", fee: "", fundingFee: "1.25" },
      // 零值非交易账单不产生日期条目
      { billId: "5", type: "9", ts: String(base), pnl: "", fee: "", fundingFee: "" },
    ]
    const days = aggregateDailyPnl(bills)
    expect(days[dayKeyLocal(base)]).toEqual({ pnl: 100 - 2 - 40 - 1 - 0.5, count: 2 })
    expect(days[dayKeyLocal(base + 86_400_000)]).toEqual({ pnl: 1.25, count: 0 })
    expect(Object.keys(days)).toHaveLength(2)
  })

  it("round-trips credentials and daily cache through localStorage", () => {
    vi.stubGlobal("localStorage", fakeStorage())
    saveLocalOkxCredentials({ apiKey: "k", secret: "s", passphrase: "p", demo: true })
    expect(loadLocalOkxCredentials()).toEqual({
      apiKey: "k",
      secret: "s",
      passphrase: "p",
      demo: true,
    })
    saveOkxDailyCache({
      version: 1,
      instType: "SWAP",
      demo: true,
      fetchedAt: 123,
      windowDays: 90,
      days: { "2026-10-02": { pnl: 5, count: 1 } },
    })
    expect(loadOkxDailyCache("SWAP")?.days["2026-10-02"]).toEqual({ pnl: 5, count: 1 })
    expect(loadOkxDailyCache("FUTURES")).toBeNull()
  })

  it("paginates bills-history with after=billId and stops before sinceTsMs", async () => {
    const now = Date.now()
    const page1: OkxBill[] = [0, 1].map((i) => ({
      billId: String(100 - i),
      type: "2",
      ts: String(now - i * 60_000),
      pnl: "1",
      fee: "0",
      fundingFee: "",
    }))
    const page2: OkxBill[] = [
      { billId: "50", type: "2", ts: String(now - 86_400_000 * 3), pnl: "2", fee: "0", fundingFee: "" },
    ]
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        urls.push(String(input))
        const after = new URL(String(input)).searchParams.get("after")
        return ok({ code: "0", msg: "", data: after ? page2 : page1 })
      }),
    )
    const out = await fetchOkxBillsSince({
      instType: "SWAP",
      sinceTsMs: now - 86_400_000,
      creds: { apiKey: "k", secret: "s", passphrase: "p", demo: true },
      maxPages: 5,
    })
    expect(out.map((b) => b.billId)).toEqual(["100", "99"])
    expect(urls).toHaveLength(2)
    expect(new URL(urls[1]).searchParams.get("after")).toBe("99")
  })

  it("signs requests with OK-ACCESS headers and rotates hosts on network failure", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
        if (seen.length === 1) throw new TypeError("network down")
        return ok({
          code: "0",
          msg: "",
          data: [{ billId: "1", type: "2", ts: String(Date.now()), pnl: "1", fee: "0", fundingFee: "" }],
        })
      }),
    )
    const out = await fetchOkxBillsSince({
      instType: "SWAP",
      sinceTsMs: 0,
      creds: { apiKey: "k", secret: "s", passphrase: "p", demo: true },
      maxPages: 1,
    })
    expect(out).toHaveLength(1)
    expect(seen[0].url).toContain("https://www.okx.com/api/v5/account/bills-history")
    expect(seen[1].url).toContain("https://aws.okx.com/api/v5/account/bills-history")
    const h = seen[0].headers
    expect(h["OK-ACCESS-KEY"]).toBe("k")
    expect(h["OK-ACCESS-PASSPHRASE"]).toBe("p")
    expect(h["x-simulated-trading"]).toBe("1")
    expect(typeof h["OK-ACCESS-SIGN"]).toBe("string")
    expect(h["OK-ACCESS-SIGN"].length).toBeGreaterThan(10)
  })

  it("throws readable business errors without host rotation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ code: "50111", msg: "", error: ["Invalid Sign"] })),
    )
    await expect(
      fetchOkxBillsSince({
        instType: "SWAP",
        sinceTsMs: 0,
        creds: { apiKey: "k", secret: "bad", passphrase: "p", demo: false },
        maxPages: 1,
      }),
    ).rejects.toThrow("50111")
  })
})
