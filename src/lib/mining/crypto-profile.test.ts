import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { EVAL_VM_WGSL } from "./gpu/wgsl/eval-vm.wgsl"
import { OPS } from "./gpu/tokens"
import { isCryptoSymbol } from "./crypto-profile"
import { Rng, gpuOpSets, pointMutate, randomTreeGpuSafe, treeToTokens } from "./gpu/gp"
import { isLocalOnly } from "@/components/factor-lab/hooks/factor-helpers"

it("detects supported crypto symbol aliases without classifying futures", () => {
  for (const s of ["BTCUSDT", "BTC-USDT-SWAP", "BTC/USDT:USDT"]) expect(isCryptoSymbol(s)).toBe(true)
  for (const s of ["rb8888", "USDT", ""]) expect(isCryptoSymbol(s)).toBe(false)
})

it("GPU initialization and point mutations keep original active feature IDs", () => {
  const rng = new Rng(42, [45, 47, 49])
  const { opOne, opTwo } = gpuOpSets()
  for (let i = 0; i < 200; i++) {
    const t = pointMutate(randomTreeGpuSafe(4, 52, opOne, opTwo, rng), 52, opOne, opTwo, rng)
    const features = treeToTokens(t).filter((id) => id < 64)
    expect(features.every((id) => [45, 47, 49].includes(id))).toBe(true)
  }
  expect(gpuOpSets(false).opOne.every((i) => i < 40)).toBe(true)
  expect(EVAL_VM_WGSL).toContain(`if (op >= ${OPS.length}u)`)
  // 0.2.44 起 isLocalOnly 按 SERVER_MISSING_FEATS={55,57,58} 判定(服务端 v3
  // 已供给 funding/taker/lsr/OI 族),旧的 104 区间启发式不再成立。
  expect(isLocalOnly([0, 55])).toBe(true)
  expect(isLocalOnly([0, 54])).toBe(false)
  expect(isLocalOnly([0, 104])).toBe(false)
})

it("real Python crypto profile: causality, calendar, availability, cached eval and sealed holdout", async () => {
  await promisify(execFile)(process.env.PYTHON ?? "python", ["-X", "utf8", "scripts/verify-crypto-profile.py"])
}, 120_000)
