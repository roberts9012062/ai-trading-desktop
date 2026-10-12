import { expect, it } from "vitest"
import { tokensToTree, treeToTokens, type Tree } from "./gp"
import { tokensGpuSupported } from "./tokens"

it("keeps TA slots and all eight shortline tokens separate from operators", () => {
  for (const id of [62, 63, ...Array.from({length:8}, (_, i) => 64 + i)]) {
    const tree: Tree = ["op", 14, ["feat", id]]
    const tokens = treeToTokens(tree)
    expect(tokens).toEqual([id < 64 ? id : 115 + id - 64, 78])
    expect(tokensToTree(tokens, 72)).toEqual(tree)
    expect(tokensGpuSupported(tokens, 72, true)).toBe(true)
    if (id >= 64) {
      expect(tokensToTree(tokens, 64)).toBeNull()
      expect(tokensGpuSupported(tokens, 64, true)).toBe(false)
      expect(tokensGpuSupported(tokens, 72)).toBe(false)
    }
  }
  expect(tokensToTree([123], 72)).toBeNull()
})
