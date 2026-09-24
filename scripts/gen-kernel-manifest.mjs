/** 重新生成 public/pykernel/kernel-files.json(内核文件增删后运行) */
import { writeFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const dir = join(root, "public/pykernel")
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".py") ? [relative(dir, join(d, e.name)).replace(/\\/g, "/")] : []
  )
const files = walk(dir).sort()
const factorFiles = files.filter(f =>
  f.startsWith("factor_lab/") || ["trading_hours.py", "session_profiles.py", "product_sectors.py", "factor_local.py", "signal_strength.py", "strategies/factor_np.py"].includes(f))
writeFileSync(join(dir, "kernel-files.json"), JSON.stringify({ files, factorFiles }, null, 0))
console.log(`listed ${files.length} kernel files (${factorFiles.length} factor)`)
