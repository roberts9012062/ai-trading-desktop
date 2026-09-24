/**
 * 强弱指标类型（V1 + V2）与版本开关
 *
 * 自 types/indicator.ts 拆出（该文件守住 300 行上限），indicator.ts
 * re-export 保持既有 `from "@/types/indicator"` 导入路径不变。
 * 数值口径与 backend schemas/indicator.py 的 StrengthSchema /
 * StrengthV2Schema 及 services/indicator/settings_store.py 完全对齐，
 * 改任一侧必须同步另一侧。
 */

/** 强弱指标 V1 配置（0–100 归一化副图 + 三档进场信号，算法见 lib/strength-index.ts） */
export interface StrengthConfig {
  /** 是否启用强弱副图 */
  enabled: boolean
  /** 归一化窗口（2-200），默认 14 */
  period: number
  /** 一次平滑周期（1-50），默认 3；1 = 不平滑 */
  smooth: number
  /** 二次平滑周期（1-50），默认 1 = 关闭 */
  smooth2: number
  /** 趋势均线周期（2-200），默认 10 */
  trendMaPeriod: number
  /** 波段进场阈值（0-100），默认 50 */
  swingThreshold: number
  /** 反弹进场阈值（0-100），默认 50 */
  reboundThreshold: number
  /** 弱区判定线（0-50），默认 20 */
  oversoldLevel: number
  /** 反弹回溯窗口（1-100 根），默认 10 */
  reboundLookback: number
  /** 极低位判定线（0-30），默认 5 */
  deepLevel: number
  /** 极低位钝化最少根数（1-50），默认 3 */
  deepBars: number
  /** 同档信号最小间隔根数（0-200），默认 3 */
  cooldown: number
  /** 走强蜡烛色，默认红 */
  upColor: string
  /** 走弱蜡烛色，默认青 */
  downColor: string
  /** 中轴线颜色，默认紫 */
  midLineColor: string
  /** 信号箭头颜色，默认白 */
  signalColor: string
}

/** 强弱指标版本：二选一，同一时刻只渲染一个版本的信号（存量用户停留 v1） */
export type StrengthVersion = "v1" | "v2"

/** 强弱指标 V2 配置（形态档：衰竭 / 确认 / 中继，双向；算法见 lib/strength-v2.ts） */
export interface StrengthV2Config {
  /** 是否启用 V2 副图（须同时 strengthVersion="v2" 才生效） */
  enabled: boolean
  /** 归一化窗口（2-200），默认 14 */
  period: number
  /** 一次平滑周期（1-50），默认 3 */
  smooth: number
  /** 二次平滑周期（1-50），默认 2 —— V2 判定与显示同用此序列（标定结论） */
  smooth2: number
  /** 多空滞回带半宽（1-25），默认 5：regime 翻转需越过 50±band */
  continuationBand: number
  /** 动能衰竭窗口（2-20），默认 3 */
  exhaustWindow: number
  /** 收缩比上限（0.1-1），默认 0.6 */
  shrinkRatio: number
  /** 走平实体上限（0.1-20），默认 2.0 */
  flatEps: number
  /** 段内相对位置容差（1-50）：距段峰/段谷 ≤ 此值算顶部/底部附近，默认 10 */
  zoneDrop: number
  /** 价格确认 ATR 缓冲倍数（0-5），默认 0.3 */
  priceBufferAtrMult: number
  /** ATR 周期（2-200），默认 14；预热段中继/衰竭不触发 */
  atrPeriod: number
  /** 同档冷却根数（0-200），默认 3 */
  cooldown: number
  /** 走强蜡烛色，默认红 */
  upColor: string
  /** 走弱蜡烛色，默认青 */
  downColor: string
  /** 中轴线颜色，默认紫 */
  midLineColor: string
  /** 做多信号箭头色，默认红 */
  longSignalColor: string
  /** 做空信号箭头色，默认绿 */
  shortSignalColor: string
}
