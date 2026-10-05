// Existing Node tests retained their former frontend/../backend fixture layout.
// Run untouched assertions against current sources using temporary import paths.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
const root = resolve(import.meta.dirname, "..")
const dir = resolve(root, ".local-data/quant-strength-tests")
mkdirSync(dir, { recursive: true })
const names = ["strength-index.test.mjs", "strength-v2.test.mjs", "strength-v2-spec.test.mjs"]
for (const name of names) {
  let source = readFileSync(resolve(root, "src/lib", name), "utf8")
  source = source.replace(/join\(import\.meta\.dirname, [^\n]+"(strength(?:_v2)?_cases\.json)"\)/g,
    (_, fixture) => JSON.stringify(resolve(root, "../Decentralized transactions/backend/tests/fixtures", fixture)))
  source = source.replaceAll('"./strength-index.ts"', '"../../src/lib/strength-index.ts"')
    .replaceAll('"./strength-v2.ts"', '"../../src/lib/strength-v2.ts"')
  writeFileSync(resolve(dir, name), source)
}
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...names.map(n => resolve(dir, n))], { cwd: root, encoding: "utf8" })
process.stdout.write(result.stdout ?? "")
process.stderr.write(result.stderr ?? "")
process.exit(result.status ?? 1)
