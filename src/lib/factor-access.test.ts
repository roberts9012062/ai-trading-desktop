import { afterEach, describe, expect, it, vi } from "vitest"
import { addFactorFavorite } from "./factor-lab-api"
import { createAITradingTask, updateAITradingTask, type CreateTaskPayload } from "./ai-trading-api"
import { desktopTokensToServerV3, isResearchOnlyFactor, serverFactorBlockReason } from "./factor-access"

afterEach(() => vi.unstubAllGlobals())
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const payload: CreateTaskPayload = { close_rules: { pnl_pct: null, total_pnl_pct: null, session_close: false, ai_auto: false }, stop_rules: { loss_pct: null, loss_amount: null, ai_auto: false }, close_on_stop: true, auto_start: false, name: "test", symbol: "btcusdt", symbol_name: "BTC", timeframe: "60m", side_mode: "both", position_mode: "fixed_qty", strategy_type: "ai", strategy_params: { factor_tokens: [0, 71] } }

describe("factor access at persistence and trading boundaries", () => {
  it("allows ordinary local formulas to be saved but keeps server AI signals separate", async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ id: "saved" }))
    vi.stubGlobal("fetch", fetch)
    await expect(addFactorFavorite({ tokens: [45, 104], text: "local", metrics: { local_only: true } })).resolves.toMatchObject({ id: "saved" })
    expect(fetch).toHaveBeenCalledOnce()
    // 2026-09-28 服务器 v3 已补齐桌面谱系：36+/104+ 不再本地专属
    expect(serverFactorBlockReason([45, 104])).toBeNull()
  })
  it.each([
    { tokens: [55, 71], metrics: {} },
    { tokens: [57, 71], metrics: {} },
    { tokens: [58, 71], metrics: {} },
    { tokens: [14, 71], metrics: { data_channel: "gate_usdt" } },
  ])("rejects research-only favorites (server-missing direct features / gate channel) before any POST", async ({ tokens, metrics }) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
    expect(isResearchOnlyFactor(tokens, metrics)).toBe(true)
    await expect(addFactorFavorite({ tokens, metrics, text: "research" })).rejects.toThrow("本地研究")
    expect(fetch).not.toHaveBeenCalled()
  })
  it("legacy research_only flags no longer block: server v3 covers those features now", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ items: [{ tokens: [0, 71], metrics: { research_only: true } }] }))
      .mockImplementation(async () => reply({ id: "task" }))
    vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask(payload)).resolves.toMatchObject({ id: "task" })
  })
  it("direct-data tokens with server-side sources mount as v3 (54→75, 71→135)", async () => {
    let call = 0
    const fetch = vi.fn().mockImplementation(async () => reply(call++ === 0 ? { items: [] } : { id: "task" }))
    vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask({ ...payload, strategy_params: { factor_tokens: [54, 71] } })).resolves.toMatchObject({ id: "task" })
    const body = JSON.parse(fetch.mock.calls.at(-1)![1].body)
    expect(body.strategy_params.factor_tokens).toEqual([75, 135])
    // 幂等：已是 v3 的 token 原样（不被二次平移）
    expect(desktopTokensToServerV3([75, 135])).toEqual([75, 135])
    expect(desktopTokensToServerV3([46, 111, 64])).toEqual([67, 175, 128])
  })
  it("permits a supported saved factor and leaves factor-free tasks unaffected", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ items: [{ tokens: [0, 71], metrics: {} }] }))
      .mockImplementation(async () => reply({ id: "task" }))
    vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask(payload)).resolves.toMatchObject({ id: "task" })
    expect(fetch.mock.calls[1][1].method).toBe("POST")
    await expect(createAITradingTask({ ...payload, strategy_params: {} })).resolves.toMatchObject({ id: "task" })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it("also guards editing old AI tasks before sending PATCH", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ strategy_type: "ai", symbol: "btcusdt" }))
      .mockResolvedValue(reply({ items: [{ tokens: [0, 71], metrics: { data_channel: "gate_usdt" } }] }))
    vi.stubGlobal("fetch", fetch)
    await expect(updateAITradingTask("old", { strategy_params: { factor_tokens: [0, 71] } })).rejects.toThrow("本地研究")
    expect(fetch.mock.calls.every((c) => c[1]?.method !== "PATCH")).toBe(true)
  })
  it("does not impose the server AI restriction on local factor strategy creation", async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ id: "local" })); vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask({ ...payload, strategy_type: "factor", strategy_params: { factor_tokens: [45, 104] } })).resolves.toMatchObject({ id: "local" })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
