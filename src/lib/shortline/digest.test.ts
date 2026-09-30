import { describe, expect, it } from "vitest"
import { BucketAccumulator } from "./bucket-stream"
import { decodeDigest, digestSha256, encodeDigest, sha256Hex, type TickBucket } from "./digest"

function bucket(ts: number, o = 100, h = 110, l = 90, c = 105, vol = 5): TickBucket {
  return { ts, open: o, high: h, low: l, close: c, vol, quote: vol * c, takerBuyVol: 2, takerBuyQuote: 2 * c, count: 3 }
}

describe("sha256Hex", () => {
  it("与已知向量一致", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

describe("digest 编解码", () => {
  it("roundtrip 逐位一致", () => {
    const buckets = [bucket(1), bucket(2, 99.5), bucket(70)]
    const bytes = encodeDigest(buckets)
    expect(bytes.byteLength).toBe(3 * 72)
    const back = decodeDigest(bytes)
    expect(back.length).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(back[i]!.ts).toBe(buckets[i]!.ts)
      for (const k of ["open", "high", "low", "close", "vol", "quote", "takerBuyVol", "takerBuyQuote"] as const) {
        expect(back[i]![k]).toBe(buckets[i]![k])
      }
      expect(back[i]!.count).toBe(buckets[i]!.count)
    }
  })

  it("同输入同 SHA（确定性）", () => {
    const a = [bucket(5), bucket(9, 1, 2, 0.5, 1.5)]
    const b = [bucket(5), bucket(9, 1, 2, 0.5, 1.5)]
    expect(digestSha256(a)).toBe(digestSha256(b))
    expect(digestSha256(a)).not.toBe(digestSha256([bucket(5)]))
  })

  it("非法长度报错", () => {
    expect(() => decodeDigest(new Uint8Array(61))).toThrow()
  })
})

describe("BucketAccumulator", () => {
  it("同秒合并 OHLC", () => {
    const acc = new BucketAccumulator()
    acc.pushEvent({ T: 1000, price: 100, qty: 1, m: false })
    acc.pushEvent({ T: 1500, price: 110, qty: 2, m: true })
    acc.pushEvent({ T: 1900, price: 95, qty: 1.5, m: false })
    const list = acc.list()
    expect(list.length).toBe(1)
    const b = list[0]!
    expect(b.ts).toBe(1)
    expect(b.open).toBe(100)
    expect(b.high).toBe(110)
    expect(b.low).toBe(95)
    expect(b.close).toBe(95)
    expect(b.vol).toBe(4.5)
    expect(b.takerBuyVol).toBe(2.5) // 主动买 = m=false 两笔
    expect(b.count).toBe(3)
  })

  it("时间回退抛错（冻结数据集不允许乱序）", () => {
    const acc = new BucketAccumulator()
    acc.pushEvent({ T: 2000, price: 1, qty: 1, m: true })
    expect(() => acc.pushEvent({ T: 1999, price: 1, qty: 1, m: true })).toThrow()
  })
})
