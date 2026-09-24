import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { it } from "vitest"

it("真实 Python 内核：加密币成本、CPU/GPU 精算一致且保留亏损淘汰", async () => {
  await promisify(execFile)(process.env.PYTHON ?? "python", ["scripts/verify-crypto-mining-cost.py"])
}, 30_000)
