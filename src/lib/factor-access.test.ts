import { afterEach, describe, expect, it, vi } from "vitest"
import { addFactorFavorite } from "./factor-lab-api"
import { createAITradingTask, updateAITradingTask, type CreateTaskPayload } from "./ai-trading-api"
import { desktopTokensToServerV3, isResearchOnlyFactor, requiresLocalFactorEngine, serverFactorBlockReason } from "./factor-access"

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
  ])("saves qualified direct-data champions without claiming server signal support", async ({ tokens, metrics }) => {
    const fetch = vi.fn().mockResolvedValue(reply({ id: "saved" })); vi.stubGlobal("fetch", fetch)
    expect(isResearchOnlyFactor(tokens, metrics)).toBe(true)
    const evidence = { ...metrics, candidate_status: "holdout_passed", holdout_passed: true }
    await expect(addFactorFavorite({ tokens, metrics: evidence, text: "champion" })).resolves.toMatchObject({ id: "saved" })
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.tokens).toEqual(tokens)
    expect(body.metrics).toEqual(evidence)
    expect(serverFactorBlockReason(tokens, evidence)).not.toBeNull()
  })
  it("legacy research_only flags no longer block: server v3 covers those features now", async () => {
    const fetch = vi.fn().mockImplementation(async () => reply({ id: "task" }))
    vi.stubGlobal("fetch", fetch)
    expect(serverFactorBlockReason([0, 71], { research_only: true })).toBeNull()
    await expect(createAITradingTask(payload)).resolves.toMatchObject({ id: "task" })
  })
  it("direct-data tokens with server-side sources mount as v3 (54→75, 71→135)", async () => {
    const fetch = vi.fn().mockImplementation(async () => reply({ id: "task" }))
    vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask({ ...payload, strategy_params: { factor_tokens: [54, 71] } })).resolves.toMatchObject({ id: "task" })
    const body = JSON.parse(fetch.mock.calls.at(-1)![1].body)
    expect(body.strategy_params.factor_tokens).toEqual([75, 135])
    // 幂等：已是 v3 的 token 原样（不被二次平移）
    expect(desktopTokensToServerV3([75, 135])).toEqual([75, 135])
    expect(desktopTokensToServerV3([46, 111, 64])).toEqual([67, 175, 128])
  })
  it("permits a supported saved factor and leaves factor-free tasks unaffected", async () => {
    const fetch = vi.fn().mockImplementation(async () => reply({ id: "task" }))
    vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask(payload)).resolves.toMatchObject({ id: "task" })
    expect(fetch.mock.calls[0][1].method).toBe("POST")
    await expect(createAITradingTask({ ...payload, strategy_params: {} })).resolves.toMatchObject({ id: "task" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("also guards unavailable data features when editing old AI tasks before PATCH", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ strategy_type: "ai", symbol: "btcusdt" }))
      .mockResolvedValue(reply({ items: [{ tokens: [0, 71], metrics: { data_channel: "gate_usdt" } }] }))
    vi.stubGlobal("fetch", fetch)
    await expect(updateAITradingTask("old", { strategy_params: { factor_tokens: [55, 71] } })).rejects.toThrow("服务器任务")
    expect(fetch.mock.calls.every((c) => c[1]?.method !== "PATCH")).toBe(true)
  })
  it("does not impose the server AI restriction on local factor strategy creation", async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ id: "local" })); vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask({ ...payload, strategy_type: "factor", strategy_params: { factor_tokens: [45, 104] } })).resolves.toMatchObject({ id: "local" })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it.each([36, 37, 38, 54, 56, 59, 60, 61])("supported feature %i has identical access before and after v3 conversion", (feature) => {
    const desktop = [feature, 71]
    const server = desktopTokensToServerV3(desktop)
    const legacy = { local_only: true, research_only: true, candidate_status: "holdout_passed" }
    for (const tokens of [desktop, server]) {
      expect(isResearchOnlyFactor(tokens, legacy)).toBe(false)
      expect(requiresLocalFactorEngine(tokens, legacy)).toBe(false)
      expect(serverFactorBlockReason(tokens, legacy)).toBeNull()
    }
  })
  it.each([55, 57, 58])("unsupported feature %i remains blocked for server AI in both encodings", async (feature) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
    for (const tokens of [[feature, 71], desktopTokensToServerV3([feature, 71])]) {
      expect(isResearchOnlyFactor(tokens)).toBe(true)
      await expect(createAITradingTask({ ...payload, strategy_params: { factor_tokens: tokens } })).rejects.toThrow("服务器任务")
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it("already-converted supported AI factors reach POST without a false missing-feature rejection", async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ id: "task" }))
    vi.stubGlobal("fetch", fetch)
    await expect(createAITradingTask({ ...payload, strategy_params: { factor_tokens: [57, 135] } })).resolves.toMatchObject({ id: "task" })
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).strategy_params.factor_tokens).toEqual([57, 135])
  })
  it("research data provenance is retained without denying supported server formulas", async () => {
    const tokens = [6, 59, 64, 112, 48, 87, 82, 4, 50, 6, 6, 104, 93, 112, 100, 68, 66, 13, 66, 70, 70, 99]
    const metrics = { data_channel: "gate_usdt", research_only: true, local_only: true, candidate_status: "holdout_passed", holdout_passed: true }
    const fetch = vi.fn().mockImplementation(async (_url, init) => reply(init?.method === "POST" ? { id: "saved" } : { items: [{ tokens, metrics }] }))
    vi.stubGlobal("fetch", fetch)
    expect(serverFactorBlockReason(tokens, metrics)).toBeNull()
    await expect(addFactorFavorite({ tokens, text: "用户提供的 Beta/SNR 公式", metrics })).resolves.toMatchObject({ id: "saved" })
    expect(JSON.parse(fetch.mock.calls[0][1].body).metrics).toEqual(metrics)
    await expect(createAITradingTask({ ...payload, strategy_params: { factor_tokens: desktopTokensToServerV3(tokens) } })).resolves.toMatchObject({ id: "saved" })
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).strategy_params.factor_tokens).toEqual(desktopTokensToServerV3(tokens))
  })
  it("mounts every member of an AI reference combo without flattening its formulas", async () => {
    const fetch = vi.fn().mockImplementation(async () => reply({ id: "server-combo" }))
    vi.stubGlobal("fetch", fetch)
    const groups = [[59, 71], [36, 71]]
    await createAITradingTask({ ...payload, strategy_params: { factor_tokens: groups } })
    expect(JSON.parse(fetch.mock.calls[0][1].body).strategy_params.factor_tokens)
      .toEqual([[80, 135], [57, 135]])
    expect(fetch).toHaveBeenCalledOnce()
  })
  it.each(["factor", "ai", "decision"])("prevents a %s combo with unavailable server inputs from being created", async (kind) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
    const params = { factor_tokens: [[0, 135], [78, 135]] }
    const strategy_params = kind === "decision" ? { decision_strategy: { kind: "factor", params } } : params
    await expect(createAITradingTask({ ...payload, strategy_type: kind, strategy_params })).rejects.toThrow("服务器")
    expect(fetch).not.toHaveBeenCalled()
  })
})
