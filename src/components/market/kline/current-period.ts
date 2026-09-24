/**
 * 当前 K 线周期（模块级）—— 供合约列表预取时读取
 * 由 KlineChart 在 period 变化时写入
 */

import type { KlinePeriod } from "@/types"

let currentPeriod: KlinePeriod = "1d"

/** 记录用户当前正在看的周期 */
export function setCurrentKlinePeriod(period: KlinePeriod): void {
  currentPeriod = period
}

/** 读取当前周期（默认日线） */
export function getCurrentKlinePeriod(): KlinePeriod {
  return currentPeriod
}
