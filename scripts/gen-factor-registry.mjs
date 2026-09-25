/** 生成 factor registry v3 的双端数据文件(方案任务 6 §9.2-2)
 *
 * 静态元数据唯一来源: schemas/factor-registry-v3.json
 * 生成: public/pykernel/factor_lab/registry_data.py(Python 内核)
 *      src/lib/mining/registry-data.ts(TS 前端镜像)
 * 两侧内嵌同一 registryHash(canonical JSON 的 SHA-256);CI/verify 脚本
 * 检查重新生成无差异。计算函数仍分别实现(ops.py / WGSL),本文件只生成
 * 元数据,不生成代码。
 *
 * 用法: node scripts/gen-factor-registry.mjs [--check]
 *   --check: 不写文件,只校验现有生成物与 schema 一致(退出码非 0 = 有差异)
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const schemaPath = resolve(root, "schemas/factor-registry-v3.json")
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"))

/** canonical 序列化:键排序 + 紧凑 —— registryHash 的确定性基础 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** JSON 值 → Python 字面量(布尔/空值正确化;缩进可读) */
function pyLiteral(value, indent = 0) {
  const pad = "    ".repeat(indent)
  const padIn = "    ".repeat(indent + 1)
  if (value === null) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    const items = value.map((v) => padIn + pyLiteral(v, indent + 1)).join(",\n")
    return `[\n${items},\n${pad}]`
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
    if (!keys.length) return "{}"
    const items = keys.map((k) => `${padIn}${JSON.stringify(k)}: ${pyLiteral(value[k], indent + 1)}`).join(",\n")
    return `{\n${items},\n${pad}}`
  }
  return JSON.stringify(value)
}

const registryHash = createHash("sha256")
  .update(canonical({ features: schema.features, operators: schema.operators, limits: schema.limits, outputMappings: schema.outputMappings }))
  .digest("hex")
const registryVersion = schema.registryVersion

const pyOut = `# -*- coding: utf-8 -*-
"""registry_data —— factor registry v3 生成数据(勿手改)。

来源: schemas/factor-registry-v3.json;生成器: scripts/gen-factor-registry.mjs
registryHash = canonical(schema 核心字段) 的 SHA-256,与 src/lib/mining/registry-data.ts
内嵌值必须一致(verify-expression-v3.py 校验)。计算函数在 ops.py 单独实现。
"""

REGISTRY_VERSION = ${JSON.stringify(registryVersion)}
REGISTRY_HASH = ${JSON.stringify(registryHash)}

LIMITS = ${pyLiteral(schema.limits)}

OUTPUT_MAPPINGS = ${pyLiteral(schema.outputMappings)}

FEATURES = ${pyLiteral(schema.features)}

OPERATORS = ${pyLiteral(schema.operators)}
`

const tsOut = `/**
 * registry-data —— factor registry v3 生成数据(勿手改)。
 *
 * 来源: schemas/factor-registry-v3.json;生成器: scripts/gen-factor-registry.mjs
 * registryHash 与 public/pykernel/factor_lab/registry_data.py 内嵌值必须一致
 * (verify-expression-v3.py 校验)。
 */

export const REGISTRY_VERSION = ${JSON.stringify(registryVersion)}
export const REGISTRY_HASH = ${JSON.stringify(registryHash)}

export interface RegistryParam {
  name: string
  type: "int"
  enum: number[]
  required?: boolean
  default?: number
}

export interface RegistryFeature {
  name: string
  canonicalId: number
  outputType: "signed_signal" | "positive_scale" | "bounded_weight"
  requiredFields: string[]
  lookbackBars: number
  params: RegistryParam[]
  description: string
}

export interface RegistryOperator {
  name: string
  arity: 1 | 2
  outputType: "signed_signal" | "positive_scale" | "bounded_weight"
  params: RegistryParam[]
  /** lookback 表达式:"0" | "<param>" | "<param>-1"(registry 求值) */
  lookbackExpr: string
  cpu: boolean
  gpu: boolean
  description: string
}

export const LIMITS = ${JSON.stringify(schema.limits, null, 1)} as const

export const OUTPUT_MAPPINGS = ${JSON.stringify(schema.outputMappings)} as const

export const FEATURES: readonly RegistryFeature[] = ${JSON.stringify(schema.features, null, 1)}

export const OPERATORS: readonly RegistryOperator[] = ${JSON.stringify(schema.operators, null, 1)}
`

// pykernel 目录按字节存储且约定 CRLF(.gitattributes -text);TS 走文本
// 归一化用 LF。生成器按各自约定写出,--check 按字节比对。
function withLineEndings(text, eol) {
  return text.split("\n").map((l) => l.replace(/\r$/, "")).join(eol)
}
const PY_EOL = String.fromCharCode(13) + "\n" // CRLF
const targets = [
  [resolve(root, "public/pykernel/factor_lab/registry_data.py"), withLineEndings(pyOut, PY_EOL)],
  [resolve(root, "src/lib/mining/registry-data.ts"), withLineEndings(tsOut, "\n")],
]

const check = process.argv.includes("--check")
let dirty = false
for (const [path, content] of targets) {
  const current = existsSync(path) ? readFileSync(path, "utf-8") : null
  if (current !== content) {
    dirty = true
    if (!check) writeFileSync(path, content, { flag: "w" })
    console.log(`${check ? "DRIFT" : "WROTE"} ${path}`)
  }
}
if (check) {
  if (dirty) {
    console.error("registry 生成物与 schema 不一致:运行 node scripts/gen-factor-registry.mjs 后提交")
    process.exit(1)
  }
  console.log(`registry ${registryVersion} hash=${registryHash.slice(0, 16)}… OK (no drift)`)
} else {
  console.log(`registry ${registryVersion} hash=${registryHash.slice(0, 16)}… (${targets.length} files)`)
}
