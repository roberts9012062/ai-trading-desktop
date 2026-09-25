/**
 * v3 表达式 TS 镜像(方案任务 6 §9.2)
 *
 * 与内核 factor_lab/expression_v3.py 同契约:类型、校验(白名单/有界
 * 参数/深度/节点数/累计 lookback)、规范化与哈希(canonical JSON 的
 * SHA-256)。计算不在 TS 侧执行——v3 首版一律由 Pyodide 内核 CPU 执行;
 * 本模块供 UI 校验输入、展示公式文本、导出/历史恢复时对哈希。
 */

import {
  FEATURES,
  LIMITS,
  OPERATORS,
  OUTPUT_MAPPINGS,
  REGISTRY_VERSION,
} from "./registry-data"

export const EXPRESSION_VERSION = 3
export const SUPPORTED_PROFILES = ["crypto_local_v2"] as const

export interface V3FeatureNode {
  feature: string
  params?: Record<string, number>
}

export interface V3OpNode {
  op: string
  params?: Record<string, number>
  args: V3Node[]
}

export type V3Node = V3FeatureNode | V3OpNode

export interface V3Expression {
  version: 3
  profile: string
  registryVersion?: string
  outputMapping?: string
  root: V3Node
}

const FEATURE_BY_NAME = new Map(FEATURES.map((f) => [f.name, f]))
const OPERATOR_BY_NAME = new Map(OPERATORS.map((o) => [o.name, o]))

function isFeatureNode(n: V3Node): n is V3FeatureNode {
  return typeof (n as V3FeatureNode).feature === "string"
}

function lookbackOfParam(expr: string, params: Record<string, number>): number {
  if (expr === "0") return 0
  if (expr in params) return params[expr]
  const m = expr.match(/^(.+)-1$/)
  if (m && m[1].trim() in params) return params[m[1].trim()] - 1
  return 0
}

function nodeLookback(node: V3Node): number {
  if (isFeatureNode(node)) {
    const feat = FEATURE_BY_NAME.get(node.feature)
    if (!feat) return 0
    return feat.lookbackBars + (node.params?.lagBars ?? 0)
  }
  const op = OPERATOR_BY_NAME.get(node.op)
  if (!op) return 0
  return lookbackOfParam(op.lookbackExpr, node.params ?? {})
}

export function astLookback(node: V3Node): number {
  if (isFeatureNode(node)) return nodeLookback(node)
  return nodeLookback(node) + Math.max(0, ...node.args.map(astLookback))
}

function astDepth(node: V3Node): number {
  if (isFeatureNode(node)) return 1
  return 1 + Math.max(0, ...node.args.map(astDepth))
}

function nodeCount(node: V3Node): number {
  if (isFeatureNode(node)) return 1
  return 1 + node.args.reduce((s, c) => s + nodeCount(c), 0)
}

function validateNode(node: unknown, errors: string[], path: string): void {
  if (typeof node !== "object" || node === null) {
    errors.push(`${path}: 节点必须是对象`)
    return
  }
  const n = node as Record<string, unknown>
  if (typeof n.feature === "string") {
    const feat = FEATURE_BY_NAME.get(n.feature)
    if (!feat) {
      errors.push(`${path}: 未知特征 ${n.feature}(白名单外)`)
      return
    }
    const params = (n.params ?? {}) as Record<string, unknown>
    const known = new Set(feat.params.map((p) => p.name))
    for (const k of Object.keys(params)) {
      if (!known.has(k)) errors.push(`${path}: 特征 ${feat.name} 不接受参数 ${k}`)
    }
    for (const p of feat.params) {
      const v = params[p.name]
      if (v === undefined) {
        if (p.default === undefined) errors.push(`${path}: 缺必填参数 ${p.name}`)
      } else if (typeof v !== "number" || !Number.isInteger(v) || !p.enum.includes(v)) {
        errors.push(`${path}: 参数 ${p.name}=${String(v)} 不在枚举 ${JSON.stringify(p.enum)}`)
      }
    }
    if (n.args !== undefined) errors.push(`${path}: 特征节点不得有 args`)
    return
  }
  const opName = String(n.op ?? "")
  const op = OPERATOR_BY_NAME.get(opName)
  if (!op) {
    errors.push(`${path}: 未知算子 ${opName}(白名单外)`)
    return
  }
  const params = (n.params ?? {}) as Record<string, unknown>
  const known = new Set(op.params.map((p) => p.name))
  for (const k of Object.keys(params)) {
    if (!known.has(k)) errors.push(`${path}: 算子 ${opName} 不接受参数 ${k}`)
  }
  for (const p of op.params) {
    const v = params[p.name]
    if (v === undefined) {
      if (p.required && p.default === undefined) errors.push(`${path}: 算子 ${opName} 缺必填参数 ${p.name}`)
    } else if (typeof v !== "number" || !Number.isInteger(v) || !p.enum.includes(v)) {
      errors.push(`${path}: 算子 ${opName} 参数 ${p.name}=${String(v)} 不在枚举 ${JSON.stringify(p.enum)}`)
    }
  }
  const args = n.args
  if (!Array.isArray(args) || args.length !== op.arity) {
    errors.push(`${path}: 算子 ${opName} 需要 ${op.arity} 个参数节点`)
    return
  }
  args.forEach((c, i) => validateNode(c, errors, `${path}.args[${i}]`))
}

/** 校验 v3 表达式;返回违规清单(空 = 合法)。与内核 registry.py 同规则。 */
export function validateExpression(expr: unknown): string[] {
  const errors: string[] = []
  if (typeof expr !== "object" || expr === null) return ["表达式必须是对象"]
  const e = expr as Record<string, unknown>
  if (e.version !== EXPRESSION_VERSION) {
    return [`未知表达式版本 ${String(e.version)}:v3 要求 version=3(不猜测整数范围)`]
  }
  if (!SUPPORTED_PROFILES.includes(e.profile as never)) {
    errors.push(`profile ${String(e.profile)} 不支持 v3(支持: ${SUPPORTED_PROFILES.join(", ")})`)
  }
  if (e.registryVersion !== undefined && e.registryVersion !== REGISTRY_VERSION) {
    errors.push(`registryVersion 不匹配:公式 ${String(e.registryVersion)} vs 当前 ${REGISTRY_VERSION}`)
  }
  if (e.outputMapping !== undefined && !OUTPUT_MAPPINGS.includes(e.outputMapping as never)) {
    errors.push(`未知 outputMapping ${String(e.outputMapping)}`)
  }
  const knownTop = new Set(["version", "profile", "registryVersion", "root", "outputMapping"])
  for (const k of Object.keys(e)) {
    if (!knownTop.has(k)) errors.push(`表达式外层未知字段: ${k}`)
  }
  if (e.root === undefined || e.root === null) {
    errors.push("缺 root 节点")
    return errors
  }
  validateNode(e.root, errors, "root")
  if (errors.length === 0) {
    const d = astDepth(e.root as V3Node)
    if (d > LIMITS.maxDepth) errors.push(`深度 ${d} 超限(≤${LIMITS.maxDepth})`)
    const c = nodeCount(e.root as V3Node)
    if (c > LIMITS.maxNodes) errors.push(`节点数 ${c} 超限(≤${LIMITS.maxNodes})`)
    const lb = astLookback(e.root as V3Node)
    if (lb > LIMITS.maxCumulativeLookback) errors.push(`累计 lookback ${lb} 超限(≤${LIMITS.maxCumulativeLookback})`)
  }
  return errors
}

/** canonical JSON(键排序+紧凑):与内核 canonical_json 逐字节一致 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** 规范化外层:补 registryVersion/outputMapping 默认(与内核一致) */
export function normalizeExpression(expr: V3Expression): V3Expression {
  return {
    version: 3,
    profile: expr.profile || SUPPORTED_PROFILES[0],
    registryVersion: REGISTRY_VERSION,
    outputMapping: expr.outputMapping || "rolling_zscore",
    root: normalizeNode(expr.root),
  }
}

function normalizeNode(node: V3Node): V3Node {
  if (isFeatureNode(node)) {
    const feat = FEATURE_BY_NAME.get(node.feature)!
    const params: Record<string, number> = {}
    for (const p of feat.params) {
      const v = node.params?.[p.name] ?? p.default
      if (v !== undefined) params[p.name] = v
    }
    return { feature: feat.name, ...(Object.keys(params).length ? { params } : {}) }
  }
  const op = OPERATOR_BY_NAME.get(node.op)!
  const params: Record<string, number> = {}
  for (const p of op.params) {
    if (p.default !== undefined) params[p.name] = p.default
    if (node.params?.[p.name] !== undefined) params[p.name] = node.params[p.name]
  }
  return {
    op: op.name,
    ...(Object.keys(params).length ? { params } : {}),
    args: node.args.map(normalizeNode),
  }
}

/** 公式哈希(canonical normalized AST 的 SHA-256 前 16 位;异步——Web Crypto) */
export async function expressionHash(expr: V3Expression): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(normalizeExpression(expr)))
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)
}

/** 人读公式文本(与内核 to_text 同格式) */
export function toText(expr: V3Expression): string {
  const render = (node: V3Node): string => {
    if (isFeatureNode(node)) {
      const p = node.params ?? {}
      const keys = Object.keys(p).sort()
      return keys.length ? `${node.feature}[${keys.map((k) => `${k}=${p[k]}`).join(",")}]` : node.feature
    }
    const p = node.params ?? {}
    const keys = Object.keys(p).sort()
    const args = node.args.map(render).join(",")
    return `${node.op}(${args}${keys.length ? "," + keys.map((k) => `${k}=${p[k]}`).join(",") : ""})`
  }
  try {
    return render(expr.root)
  } catch {
    return "<invalid-v3>"
  }
}

/** v3 首版一律 CPU(WGSL instruction buffer 未上线);能力协商入口 */
export function isV3GpuSupported(_expr: V3Expression): boolean {
  return false
}

/** 表达式依赖的原始 bar 字段(数据能力预检) */
export function requiredFields(expr: V3Expression): Set<string> {
  const out = new Set<string>()
  const walk = (node: V3Node): void => {
    if (isFeatureNode(node)) {
      const feat = FEATURE_BY_NAME.get(node.feature)
      if (feat) feat.requiredFields.forEach((f) => out.add(f))
    } else {
      node.args.forEach(walk)
    }
  }
  walk(expr.root)
  return out
}
