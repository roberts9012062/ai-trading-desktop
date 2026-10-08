import { SWING_VERSION } from "./rules"

/** Current creation choices. Legacy versions remain readable in frozen plans. */
export const HUNTER_STRATEGIES = [
  { version: SWING_VERSION, label: "趋势猎手 V4 · 波段持有 / 多周期延续 / 确认反转" },
  { version: "hunter-rebound", label: "反弹猎手 · 急跌抢反弹 / 急涨动能衰竭 / 锁利管理" },
] as const
export const DEFAULT_HUNTER_VERSION = SWING_VERSION
