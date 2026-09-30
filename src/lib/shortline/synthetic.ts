/**
 * 确定性合成 tick 生成器（测试/夹具用）。
 *
 * 种子 LCG——无 Math.random、无时钟，同种子逐位一致。可生成 WS 事件或
 * CSV 行；秒级稀疏度可调（平均每 tradeEveryAvgSec 秒一笔）。
 */

import type { AggTradeEvent } from "./bucket-stream"

export class SeededRng {
  private state: number
  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9
  }
  nextU32(): number {
    // xoshiro 简化版（数值足够确定性用途）
    let x = this.state
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.state = x
    return x >>> 0
  }
  nextFloat(): number {
    return this.nextU32() / 4294967296
  }
}

export interface SyntheticSpec {
  seed: number
  symbol: string
  /** 起始秒（UTC） */
  startTsSec: number
  /** 总秒数 */
  seconds: number
  /** 平均每多少秒一笔成交（稀疏度） */
  tradeEveryAvgSec: number
  /** 起始价 */
  startPrice?: number
  /** 单笔量纲 */
  qtyScale?: number
}

/** 生成 WS aggTrade 形态事件（时间严格单调不减） */
export function* syntheticAggTrades(spec: SyntheticSpec): Generator<AggTradeEvent> {
  const rng = new SeededRng(spec.seed)
  let price = spec.startPrice ?? 3000
  const qtyScale = spec.qtyScale ?? 1
  let t = spec.startTsSec * 1000
  const end = (spec.startTsSec + spec.seconds) * 1000
  while (t < end) {
    // 价格随机游走（±0.05%）
    const shock = (rng.nextFloat() - 0.5) * 0.001
    price = price * (1 + shock)    // 量：偶发大单
    const big = rng.nextFloat() < 0.02
    const qty = (big ? 8 : 0.2 + rng.nextFloat() * 1.5) * qtyScale
    const n = big ? 3 + Math.floor(rng.nextFloat() * 5) : 1
    yield { T: t, price, qty, m: rng.nextFloat() < 0.5, n }
    // 下一笔：指数间隔（平均 tradeEveryAvgSec）
    const gapMs = Math.max(100, Math.round(-Math.log(1 - rng.nextFloat() + 1e-9) * spec.tradeEveryAvgSec * 1000))
    t += gapMs
  }
}

/** 价格串（固定 2 位小数，模拟交易所粒度） */
export function* syntheticAggTradesRounded(spec: SyntheticSpec): Generator<AggTradeEvent> {
  for (const e of syntheticAggTrades(spec)) {
    yield { ...e, price: Number(Number(e.price).toFixed(2)) }
  }
}