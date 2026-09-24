/**
 * 指标参数示意图的固定合成 K 线序列（discuss/2026-08-31-指标参数示意图设计.md）
 *
 * 仅作回落数据：调用方（行情页/回测页）传入真实 K 线时示意图优先用真实
 * 数据；数据未就绪/分时周期/无 bars 的页面才落到本序列。确定性生成（正弦
 * 叠加，无随机数），形态覆盖：缓涨 → 急拉 → 顶部盘整 → 下跌 → 底部走平
 * → 修复上行 → 二次回调 → 新高，约 110 根日线。
 */

import type { KlineBar } from "@/types"

/** 由收盘价与种子相位确定性地展开一根 OHLC（影线用相位扰动，避免随机数） */
function barAt(i: number, close: number, prevClose: number): KlineBar {
  const open = i === 0 ? close - 0.8 : prevClose
  const wickUp = 0.6 + 0.5 * Math.abs(Math.sin(i * 2.399))
  const wickDn = 0.6 + 0.5 * Math.abs(Math.cos(i * 1.913))
  return {
    time: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    open,
    high: Math.max(open, close) + wickUp,
    low: Math.min(open, close) - wickDn,
    close,
    volume: 1000,
  }
}

/** 走势分段：缓涨25 → 急拉10 → 顶盘整12 → 下跌20 → 底走平12 → 修复20 → 回调10 → 新高（共109） */
function buildBars(): KlineBar[] {
  const bars: KlineBar[] = []
  let price = 100
  let prev = price
  for (let i = 0; i < 109; i++) {
    let drift = 0
    if (i < 25) drift = 0.45 + 0.25 * Math.sin(i / 4)
    else if (i < 35) drift = 1.6
    else if (i < 47) drift = 0.05 + 0.3 * Math.sin(i / 2)
    else if (i < 67) drift = -1.15 - 0.3 * Math.sin(i / 5)
    else if (i < 79) drift = -0.05
    else if (i < 99) drift = 0.85 + 0.2 * Math.sin(i / 6)
    else if (i < 109) drift = -0.5
    // 轻微确定性抖动，避免完全平滑的假图
    price += drift + 0.12 * Math.sin(i * 1.7)
    bars.push(barAt(i, Math.round(price * 100) / 100, prev))
    prev = Math.round(price * 100) / 100
  }
  return bars
}

/** 固定合成序列（模块级常量，全程不变） */
export const PREVIEW_BARS: KlineBar[] = buildBars()
