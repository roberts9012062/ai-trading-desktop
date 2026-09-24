/**
 * 指标默认配置与预设颜色
 *
 * 从 types/indicator.ts 拆出（该文件守住 300 行上限）；
 * indicator.ts re-export 本文件的 DEFAULT_INDICATOR_CONFIG / PRESET_COLORS，
 * 调用方 `from "@/types/indicator"` 导入路径不变。
 * 数值口径与 backend services/indicator/settings_store.py 的
 * DEFAULT_CHART_CONFIG 完全对齐，改任一侧必须同步另一侧。
 */

import type { IndicatorConfig } from "./indicator"

/** 预设颜色列表 */
export const PRESET_COLORS = [
  "#3b82f6", // 蓝
  "#f59e0b", // 黄
  "#a855f7", // 紫
  "#ec4899", // 粉
  "#14b8a6", // 青
  "#ef4444", // 红
  "#22c55e", // 绿
  "#94a3b8", // 灰
] as const

/** 默认指标配置 */
export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  maLines: [
    { period: 5, color: PRESET_COLORS[0] },
    { period: 10, color: PRESET_COLORS[1] },
    { period: 20, color: PRESET_COLORS[2] },
  ],
  macd: {
    enabled: true,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    difColor: "#3b82f6",
    deaColor: "#f59e0b",
    histUpColor: "rgba(239,68,68,0.6)",
    histDownColor: "rgba(34,197,94,0.6)",
  },
  rsi: {
    enabled: false,
    period: 14,
    overbought: 70,
    oversold: 30,
    lineColor: "#14b8a6",
    overboughtColor: "rgba(239,68,68,0.7)",
    oversoldColor: "rgba(34,197,94,0.7)",
  },
  boll: {
    enabled: false,
    period: 20,
    std: 2,
    upperColor: "#a855f7",
    middleColor: "#f59e0b",
    lowerColor: "#a855f7",
    upperStyle: "dashed",
    middleStyle: "solid",
    lowerStyle: "dashed",
  },
  jdk: {
    enabled: false,
    rsvPeriod: 9,
    kPeriod: 3,
    dPeriod: 3,
    kColor: "#f59e0b",
    dColor: "#3b82f6",
    jColor: "#ec4899",
  },
  strength: {
    enabled: false,
    period: 14,
    smooth: 3,
    smooth2: 1,
    trendMaPeriod: 10,
    swingThreshold: 50,
    reboundThreshold: 50,
    oversoldLevel: 20,
    reboundLookback: 10,
    deepLevel: 5,
    deepBars: 3,
    cooldown: 8,
    upColor: "#ef4444",
    downColor: "#22d3ee",
    midLineColor: "#a855f7",
    signalColor: "#ffffff",
  },
  strengthV2: {
    enabled: false,
    period: 14,
    smooth: 3,
    smooth2: 2,
    continuationBand: 5,
    exhaustWindow: 4,
    shrinkRatio: 0.45,
    flatEps: 1.2,
    zoneDrop: 10,
    priceBufferAtrMult: 0.3,
    atrPeriod: 14,
    cooldown: 8,
    upColor: "#ef4444",
    downColor: "#22d3ee",
    midLineColor: "#a855f7",
    longSignalColor: "#ef4444",
    shortSignalColor: "#22c55e",
  },
  pivot: {
    enabled: false,
    left: 3,
    right: 3,
    alternate: true,
    minAmplitudePct: 1.5,
    minAtrMult: 1.5,
    atrPeriod: 14,
    minRightLive: 1,
    longColor: "#ef4444",
    shortColor: "#22c55e",
  },
  pivotV2: {
    enabled: false,
    left: 3,
    right: 3,
    proximityAtrMult: 1.0,
    wickAtrMult: 0.8,
    attackWindow: 3,
    volExpandRatio: 1.5,
    volShrinkRatio: 0.7,
    volMaPeriod: 20,
    cooldown: 5,
    atrPeriod: 14,
    longColor: "#ef4444",
    shortColor: "#22c55e",
    // 失效标记：假空/假多灰显带 ✕（只打标不过滤）
    markInvalidated: true,
    hideInvalidated: false,
    invalidateAtrMult: 0,
    invalidatedColor: "#6b7280",
  },
  // 存量用户默认停留在 V1，行为不变
  pivotVersion: "v1",
  strengthVersion: "v1",
}
