/**
 * v3 表达式 TS 镜像测试(与内核 verify-expression-v3.py 对应)
 *
 * - 校验规则与内核一致(非法式拒绝);
 * - canonical/规范化后哈希与内核逐字节一致(跨语言黄金对拍);
 * - 文本渲染同格式;能力协商 v3 首版一律 CPU。
 */

import { describe, expect, it } from "vitest"
import {
  EXPRESSION_VERSION,
  canonicalJson,
  expressionHash,
  isV3GpuSupported,
  normalizeExpression,
  requiredFields,
  toText,
  validateExpression,
  type V3Expression,
} from "./expression-v3"

function tsMeanExpr(w: number): V3Expression {
  return {
    version: 3,
    profile: "crypto_local_v2",
    root: { op: "ts_mean", params: { windowBars: w }, args: [{ feature: "ret" }] },
  }
}

describe("expression-v3 TS 镜像", () => {
  it("合法表达式通过校验,非法表达式拒绝(与内核同规则)", () => {
    expect(validateExpression(tsMeanExpr(20))).toEqual([])
    expect(validateExpression(tsMeanExpr(24))).toEqual([])
    const bad: Array<[string, unknown]> = [
      ["unknown_version", { version: 9, root: { feature: "ret" } }],
      ["no_version", { profile: "crypto_local_v2", root: { feature: "ret" } }],
      ["bad_profile", { ...tsMeanExpr(20), profile: "crypto_ohlcv_v1" }],
      ["eval_op", { version: 3, profile: "crypto_local_v2", root: { op: "eval", args: [] } }],
      ["window_out_of_enum", tsMeanExpr(7)],
      ["unknown_feature", { version: 3, profile: "crypto_local_v2", root: { feature: "nope" } }],
      ["missing_window", {
        version: 3, profile: "crypto_local_v2",
        root: { op: "ts_mean", args: [{ feature: "ret" }] },
      }],
      ["extra_top_field", { ...tsMeanExpr(20), tokens: [0] }],
      ["bad_arity", {
        version: 3, profile: "crypto_local_v2",
        root: { op: "ts_mean", params: { windowBars: 20 }, args: [{ feature: "ret" }, { feature: "ret5" }] },
      }],
    ]
    for (const [name, expr] of bad) {
      expect(validateExpression(expr), name).not.toEqual([])
    }
  })

  it("哈希与内核逐字节一致(跨语言黄金对拍)", async () => {
    // 内核 factor_lab.expression_v3.expression_hash 的黄金值
    expect(await expressionHash(tsMeanExpr(24))).toBe("6193582ecbc3b02f")
    expect(await expressionHash(tsMeanExpr(20))).toBe("7e766743d90e2ae5")
  })

  it("同文本不同窗口哈希不同", async () => {
    expect(await expressionHash(tsMeanExpr(20))).not.toBe(await expressionHash(tsMeanExpr(60)))
  })

  it("文本渲染与内核同格式", () => {
    expect(toText(tsMeanExpr(24))).toBe("ts_mean(ret,windowBars=24)")
  })

  it("规范化补默认且 canonical 序列化稳定", () => {
    const norm = normalizeExpression(tsMeanExpr(24))
    expect(norm.registryVersion).toBeTruthy()
    expect(norm.outputMapping).toBe("rolling_zscore")
    expect(canonicalJson(normalizeExpression(JSON.parse(canonicalJson(norm))))).toBe(canonicalJson(norm))
  })

  it("v3 首版一律 CPU(能力协商);依赖字段预检", () => {
    expect(EXPRESSION_VERSION).toBe(3)
    expect(isV3GpuSupported(tsMeanExpr(24))).toBe(false)
    const funding: V3Expression = {
      version: 3, profile: "crypto_local_v2",
      root: { op: "ts_mean", params: { windowBars: 20 }, args: [{ feature: "funding_rate" }] },
    }
    expect([...requiredFields(funding)]).toContain("funding_rate")
  })
})
