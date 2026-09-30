/**
 * 短线因子实验室 —— 冻结规格常量（forming-bar-spec/1 · shortline-eval-v1）
 *
 * 本文件是桌面↔服务器契约的数值基座：cadence 档位、v4 特征 token 表、
 * 归一化窗口、live 特征白名单。任何语义变化必须升 eval 版本号并重过
 * 黄金夹具（服务器 S1 门）。见 docs/plans/2026-09-30-shortline-lab-implementation.md。
 */

/** 契约允许的打分节奏档位（秒），字段名 cadence_seconds */
export const CADENCE_CHOICES = [3, 5, 10, 15, 30, 60] as const
export type CadenceSeconds = (typeof CADENCE_CHOICES)[number]

/** 短线支持的挖掘周期 */
export const SHORTLINE_TIMEFRAMES = ["1m", "5m", "15m"] as const
export type ShortlineTimeframe = (typeof SHORTLINE_TIMEFRAMES)[number]

export const TIMEFRAME_SECONDS: Record<ShortlineTimeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
}

/** 求值器语义版本戳（随任务载荷下发，服务器 S1 门校验对象） */
export const SHORTLINE_EVAL_VERSION = "shortline-eval-v1"
/** 形成中 K 线构造规格版本 */
export const FORMING_BAR_SPEC = "forming-bar-spec/1"
/** tick 桶摘要格式版本 */
export const DIGEST_FORMAT = "digest/1"

/** v4 短线特征 token 起点（算子止于 114，本地专属区间 115-122，append-only） */
export const SHORTLINE_TOKEN_OFFSET = 115
export const SHORTLINE_FEATURE_COUNT = 8

/** v4 特征名（顺序即 token 115..122，冻结不可重排） */
export const SHORTLINE_FEATURE_NAMES = [
  "SL_OF_IMB",
  "SL_BIG_SHARE",
  "SL_TRD_INT",
  "SL_PV_DIV",
  "SL_VWAP_DEV",
  "SL_BURST",
  "SL_STREAK_SIG",
  "SL_RHYTHM_ENT",
] as const
export type ShortlineFeatureName = (typeof SHORTLINE_FEATURE_NAMES)[number]

/** bar dict 上的 v4 列键（引擎 load_bars 动态数值列） */
export const SHORTLINE_COLUMN_KEYS: readonly string[] = SHORTLINE_FEATURE_NAMES.map(
  (_, i) => `sl_of${i}`,
)

/** v4 特征因果归一化窗口（masked zscore，冻结） */
export const SHORTLINE_ZSCORE_WINDOW = 300

/** 分数映射：score = tanh(z)，z 为 VM causal_v2 输出（clip ±3） */
export function factorToScore(z: number): number {
  return Math.tanh(z)
}

/** 组合分 = Σ wᵢ·scoreᵢ（权重来自任务载荷，冻结 IC 权重，Σw=1） */
export function comboScore(scores: readonly number[], weights: readonly number[]): number {
  if (scores.length !== weights.length) throw new Error("score/weight 长度不一致")
  let acc = 0
  for (let i = 0; i < scores.length; i++) acc += weights[i]! * scores[i]!
  return acc
}

/** 分数环形缓冲步数（契约：历史只暴露最近 50 步） */
export const SCORE_RING_STEPS = 50
/** 陈旧分数熔断倍数：age > stale_multiplier × cadence 视为过期 */
export const STALE_MULTIPLIER = 2.0

/** 决策引擎默认参数（契约 decision 块默认值） */
export const DECISION_DEFAULTS = {
  threshold: 0.25,
  confirm_steps: 3,
  max_actions_per_hour: 6,
  max_actions_per_bar: 1,
  stale_multiplier: STALE_MULTIPLIER,
} as const

/** 风控默认参数（契约 risk 块默认值；纸面模式为默认） */
export const RISK_DEFAULTS = {
  max_notional_usdt: 1000,
  daily_loss_limit_usdt: 50,
  mode: "paper",
} as const

/**
 * live 特征白名单：kline+aggTrade 流式可计算的特征 id（v4 见 isShortlineToken）。
 * 非 live：14-16/27-30（OI 族）、35（STRENGTH 镜像暂缓）、52-53/56-57/59-60（funding/LS/强平）。
 */
export const LIVE_BASE_FEATURES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, // RET..PV_CORR
  17, 18, // TOD, NIGHT
  19, 20, 21, 22, 23, 24, 25, 26, // GAP..VOLAT_RATIO
  31, 32, 33, 34, // SKEW20, KURT20, DOW, DOM
  36, 37, 38, 39, // STREAK, VWAP_DEV, UPDOWN_VOL_RATIO, CHAN_POS
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, // clock + crypto
  54, 55, 58, 61, // TAKER_IMBALANCE, QUOTE_ILLIQ20, AVG_TRADE_QUOTE, TAKER_IMB24
]

export function isShortlineToken(token: number): boolean {
  return token >= SHORTLINE_TOKEN_OFFSET && token < SHORTLINE_TOKEN_OFFSET + SHORTLINE_FEATURE_COUNT
}

/** token 是否 live 可用（base 白名单或 v4） */
export function isLiveToken(token: number): boolean {
  if (isShortlineToken(token)) return true
  if (token >= 64) return true // 算子全部可用
  return LIVE_BASE_FEATURES.includes(token)
}

/** 默认挂载品种（回填磁盘预算默认单品种） */
export const DEFAULT_SHORTLINE_SYMBOL = "ETHUSDT"
