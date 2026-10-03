import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { it } from "vitest"

it("real kernel mine_portfolio: combo_super dual scale + fold check regression", async () => {
  await promisify(execFile)(process.env.PYTHON ?? "python", ["-X", "utf8", "scripts/verify-combo-super.py"])
}, 120_000)
