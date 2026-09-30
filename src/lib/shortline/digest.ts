/**
 * 1 秒 tick 桶摘要（digest/1）—— 编解码 + SHA256。
 *
 * 记录定长 72 字节（小端）：
 *   u32 ts(UTC 秒) | f64 open | f64 high | f64 low | f64 close
 *   f64 vol | f64 quote | f64 takerBuyVol | f64 takerBuyQuote | u32 count
 * 空秒不存（稀疏）。ts 严格递增。编解码纯函数、无平台依赖（SHA256 为
 * 纯 TS 实现），node 与浏览器逐位一致——冻结数据集的 dataset SHA 依赖它。
 */

import { DIGEST_FORMAT } from "./spec"

export interface TickBucket {
  /** UTC 秒（1 秒桶起点） */
  ts: number
  open: number
  high: number
  low: number
  close: number
  /** 成交量（base） */
  vol: number
  /** 成交额（quote） */
  quote: number
  /** 主动买入量（base） */
  takerBuyVol: number
  takerBuyQuote: number
  /** 成交笔数 */
  count: number
}

export const BUCKET_RECORD_BYTES = 72

export function encodeDigest(buckets: readonly TickBucket[]): Uint8Array {
  const out = new Uint8Array(buckets.length * BUCKET_RECORD_BYTES)
  const view = new DataView(out.buffer)
  let o = 0
  for (const b of buckets) {
    view.setUint32(o, b.ts, true); o += 4
    view.setFloat64(o, b.open, true); o += 8
    view.setFloat64(o, b.high, true); o += 8
    view.setFloat64(o, b.low, true); o += 8
    view.setFloat64(o, b.close, true); o += 8
    view.setFloat64(o, b.vol, true); o += 8
    view.setFloat64(o, b.quote, true); o += 8
    view.setFloat64(o, b.takerBuyVol, true); o += 8
    view.setFloat64(o, b.takerBuyQuote, true); o += 8
    view.setUint32(o, b.count, true); o += 4
  }
  return out
}

export function decodeDigest(bytes: Uint8Array): TickBucket[] {
  if (bytes.length % BUCKET_RECORD_BYTES !== 0) {
    throw new Error(`digest 长度非法: ${bytes.length}`)
  }
  const n = bytes.length / BUCKET_RECORD_BYTES
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: TickBucket[] = new Array(n)
  let o = 0
  for (let i = 0; i < n; i++) {
    out[i] = {
      ts: view.getUint32(o, true), open: view.getFloat64(o + 4, true),
      high: view.getFloat64(o + 12, true), low: view.getFloat64(o + 20, true),
      close: view.getFloat64(o + 28, true), vol: view.getFloat64(o + 36, true),
      quote: view.getFloat64(o + 44, true), takerBuyVol: view.getFloat64(o + 52, true),
      takerBuyQuote: view.getFloat64(o + 60, true), count: view.getUint32(o + 68, true),
    }
    o += BUCKET_RECORD_BYTES
  }
  return out
}

/** 纯 TS SHA-256（FIPS 180-4）；node/browser 逐位一致 */
export function sha256Hex(data: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const l = data.length
  const bitLenHi = Math.floor(l / 0x20000000)
  const bitLenLo = (l << 3) >>> 0
  const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[l] = 0x80
  const pv = new DataView(padded.buffer)
  pv.setUint32(padded.length - 8, bitLenHi, false)
  pv.setUint32(padded.length - 4, bitLenLo, false)
  const w = new Uint32Array(64)
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = pv.getUint32(chunk + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0
  }
  let hex = ""
  for (let i = 0; i < 8; i++) hex += H[i]!.toString(16).padStart(8, "0")
  return hex
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** 数据集指纹（冻结协议：dataset SHA 进任务元数据） */
export function digestSha256(buckets: readonly TickBucket[]): string {
  return sha256Hex(encodeDigest(buckets))
}

export const DIGEST_FORMAT_VERSION = DIGEST_FORMAT
