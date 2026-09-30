/**
 * D1 门真实数据证据 —— 对真实 Binance aggTrades 归档日做双跑逐位一致验证。
 * 数据文件不存在时跳过（CI/干净环境）；下载方式见验收报告 M-D1。
 * 输出 digest SHA 与各 cadence 的重放指纹 SHA（写入验收报告）。
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { unzipSync } from "fflate"
import { BucketAccumulator } from "./bucket-stream"
import { digestSha256, sha256Hex } from "./digest"
import { replayBits, replayScores } from "./replay"

const ZIP = resolve(process.cwd(), ".local-data/shortline/ETHUSDT-aggTrades-2026-09-28.zip")
// 真实日体量大：证据跑只取当日最后 2 小时桶（截断后仍是真实数据）
const TAIL_SECONDS = 2 * 3600

function loadRealBuckets() {
  const zip = readFileSync(ZIP)
  const files = unzipSync(new Uint8Array(zip))
  const name = Object.keys(files).find((f) => f.endsWith(".csv"))!
  const acc = new BucketAccumulator()
  let count = 0
  const text = new TextDecoder().decode(files[name]!)
  for (const line of text.split("\n")) {
    const s = line.trim()
    if (!s) continue
    const cols = s.split(",")
    if (cols.length < 7) continue
    const price = Number(cols[1]), qty = Number(cols[2]), t = Number(cols[5])
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(t)) continue
    acc.pushCsvRow({ price, qty, transactTimeMs: t, isBuyerMaker: cols[6]!.trim() === "true" })
    count++
  }
  const all = acc.list()
  const tailFrom = all[all.length - 1]!.ts - TAIL_SECONDS
  const idx = all.findIndex((b) => b.ts >= tailFrom)
  return { trades: count, buckets: all.slice(idx), fullCount: all.length }
}

const FORMULAS: ReadonlyArray<readonly number[]> = [
  [0, 64 + 23, 64 + 12],
  [115, 64 + 32, 64 + 12],
  [5, 6, 64 + 29],
  [115, 116, 64 + 0, 64 + 46],
]

describe.skipIf(!existsSync(ZIP))("D1 真实数据证据（ETHUSDT aggTrades 2026-09-28）", () => {
  it("尾部 2 小时 × 多 cadence 双跑逐位一致", { timeout: 120_000 }, () => {
    const { trades, buckets, fullCount } = loadRealBuckets()
    const sha = digestSha256(buckets)
    console.log(`[D1-real] trades=${trades} buckets(full)=${fullCount} buckets(tail)=${buckets.length} digest_sha256=${sha}`)
    for (const cadence of [3, 5, 15, 60] as const) {
      const opts = {
        timeframe: "1m" as const,
        cadence,
        champions: FORMULAS.map((tokens) => ({ tokens })),
      }
      const run1 = replayScores(buckets, opts, sha)
      const run2 = replayScores(buckets, opts, sha)
      const bits = replayBits(run1)
      const bitsSha = sha256Hex(new TextEncoder().encode(bits))
      console.log(`[D1-real] cadence=${cadence}s steps=${run1.steps.length} bits_sha256=${bitsSha}`)
      expect(run1.steps.length).toBeGreaterThan(50)
      expect(replayBits(run2)).toBe(bits)
      // 真实数据分数有限性抽查
      const finite = run1.steps.filter((s) => s.combo !== null)
      expect(finite.length).toBeGreaterThan(10)
    }
  })
})
