import {afterEach, beforeEach, expect, it, vi} from "vitest"
import {generateLlmFactorSeeds} from "./llm-factor-seed"
import {factorLabRequest} from "./factor-lab-api"

vi.mock("./factor-lab-api", () => ({factorLabRequest: vi.fn()}))
vi.mock("./py-worker", () => ({ensurePyWorker: () => ({factorRun: async () => ({
  feat_offset:64, features:[{id:9,name:"RSI",text:"相对强弱"}],
  ops:[{id:71,name:"NEG",text:"取反",arity:1}],
})})}))
const options = {symbol:"ADAUSDT", timeframe:"15m", channel:"okx", bars:[{close:1}],modelRowId:"settings-model"}
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

it("uses the selected AI settings model without any second model configuration", async () => {
  vi.mocked(factorLabRequest).mockResolvedValue({content:JSON.stringify({candidates:[[9,71]],note:"测试思路"})})
  const result = await generateLlmFactorSeeds(options)
  expect(result.tokens).toEqual([[9,71]])
  const [path, init] = vi.mocked(factorLabRequest).mock.calls[0]
  expect(path).toBe("/api/factor-lab/llm-seeds")
  const body = JSON.parse(init!.body as string)
  expect(body.model_row_id).toBe("settings-model")
  expect(body.messages[1].content).toContain("ADAUSDT")
  expect(body.messages[1].content).toContain("9=RSI")
})

it("requires an explicitly selected AI settings model before any request", async () => {
  await expect(generateLlmFactorSeeds({...options,modelRowId:""})).rejects.toThrow("请先选择")
  expect(factorLabRequest).not.toHaveBeenCalled()
})

it("does not silently fall back or rewrite invalid formulas from the model", async () => {
  vi.mocked(factorLabRequest).mockRejectedValue(new Error("模型不可用"))
  await expect(generateLlmFactorSeeds(options)).rejects.toThrow("模型不可用")
  vi.mocked(factorLabRequest).mockResolvedValue({content:'{"candidates":[[9,"bad",71],[9,71],[9,71],[10,71],[9,71.5]]}'})
  expect((await generateLlmFactorSeeds(options)).tokens).toEqual([[9,71]])
})
