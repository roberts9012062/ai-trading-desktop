/**
 * 实时 K 线尾部累积器：随 WS 帧同步写入，与 React 渲染解耦
 *
 * 根治「波段/指标要刷新页面才出现」的缺根问题：
 * 服务端 kline:realtime 是单槽快照协议——Redis 每合约×周期只存当前
 * forming bar，每秒覆盖推送，已收盘 bar 的最终状态只存在于收盘前后的
 * 帧里且不会重推。旧方案把「已收盘 rt bar」累积在组件 ref 里、靠
 * useEffect 消费 store 单槽，后台标签节流/渲染饥饿时两次提交间的帧被
 * 丢，那根 bar 永久缺失且盘中无自愈（currentBars 不重拉），波段右侧
 * 确认条件永远凑不出，直到刷新页面补全历史。
 *
 * 本模块在浏览器里自行订阅 WS onMessage，帧到达即在回调里同步累积
 * （不经过 React 调度），读取侧（use-realtime-kline）按历史尾部时间
 * 剪枝后取尾部序列。同 bar 多帧用 mergeRealtimeBar 合并（版本号守卫
 * 防乱序/重放回归）。
 *
 * 纯逻辑（合并/缺口检测）无 React 依赖，可被 node --test 直测；
 * 相对导入一律带 .ts 后缀（Node 原生 TS 支持需要，tsconfig 已开
 * allowImportingTsExtensions，先例见 lib/pivot-signals-v2.ts）。
 */

import type { KlineBar, KlinePeriod } from "@/types"
import { getMarketWebSocket } from "../../../../lib/websocket.ts"
import {
  mergeRealtimeBar,
  normalizeBarTime,
  toTimestamp,
} from "../utils.ts"

/** 每个合约×周期最多累积的 bar 数（超出丢最旧；1m 下约 8 小时无人消费的余量） */
const MAX_TAIL_BARS = 480
/** 最多保留的 key 数（合约×周期组合），按最近写入时间淘汰 */
const MAX_KEYS = 32

interface RtKeyEntry {
  /** barTimeKey → 累积后的 bar（同 bar 多帧已合并） */
  bars: Map<string, KlineBar>
  touchedAt: number
}

const _store = new Map<string, RtKeyEntry>()

/** 累积器的 key：合约小写 + 周期（与服务端推送/订阅口径一致） */
export function rtAccKey(symbol: string, period: string): string {
  return `${String(symbol || "").trim().toLowerCase()}:${period}`
}

function dropOldestBar(entry: RtKeyEntry): void {
  let oldest: string | null = null
  for (const t of entry.bars.keys()) {
    // 时间键（YYYY-MM-DD[ HH:MM:SS]）字典序即时间序
    if (oldest === null || t < oldest) oldest = t
  }
  if (oldest !== null) entry.bars.delete(oldest)
}

function evictOldestKey(): void {
  let oldest: string | null = null
  for (const [k, e] of _store) {
    if (oldest === null || e.touchedAt < _store.get(oldest)!.touchedAt) {
      oldest = k
    }
  }
  if (oldest !== null) _store.delete(oldest)
}

/**
 * WS kline 帧到达即调用（浏览器侧由模块级订阅接线，见文件底部）。
 * 同 bar 后续帧用 mergeRealtimeBar 合并（高/低水位 + 版本号守卫）。
 */
export function offerRtBar(symbol: string, period: string, bar: KlineBar): void {
  if (!symbol || !period || !bar || !bar.time) return
  const key = rtAccKey(symbol, period)
  let entry = _store.get(key)
  if (!entry) {
    if (_store.size >= MAX_KEYS) evictOldestKey()
    entry = { bars: new Map(), touchedAt: Date.now() }
    _store.set(key, entry)
  }
  entry.touchedAt = Date.now()
  const t = normalizeBarTime(period as KlinePeriod, bar.time)
  if (!t) return
  const prev = entry.bars.get(t)
  entry.bars.set(t, prev ? mergeRealtimeBar(prev, bar) : bar)
  if (entry.bars.size > MAX_TAIL_BARS) dropOldestBar(entry)
}

/** 批量帧入口（一条 WS 消息的 data 数组） */
export function offerRtFrames(
  frames: Array<{ symbol?: unknown; period?: unknown; bar?: unknown }>,
): void {
  if (!Array.isArray(frames)) return
  for (const item of frames) {
    if (!item || typeof item !== "object") continue
    const bar = item.bar
    if (!bar || typeof bar !== "object") continue
    offerRtBar(
      String(item.symbol ?? ""),
      String(item.period ?? ""),
      bar as KlineBar,
    )
  }
}

/**
 * 读取历史尾部之后的累积 bar（含与历史最后一根同时间的 forming 帧）：
 * 先剪掉已被历史覆盖的旧键（< lastT），返回键 ≥ lastT 的时间升序列表。
 * 剪枝在读取时做——累积器不感知历史，历史重拉尾前移后自动淘汰。
 */
export function readRtTail(key: string, lastT: string): KlineBar[] {
  const entry = _store.get(key)
  if (!entry) return []
  entry.touchedAt = Date.now()
  if (lastT) {
    for (const t of entry.bars.keys()) {
      if (t < lastT) entry.bars.delete(t)
    }
  }
  return [...entry.bars.keys()]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((t) => entry.bars.get(t)!)
    .filter(Boolean)
}

/** 清空累积器（测试用；不带 key 清全部） */
export function clearRtAccumulator(key?: string): void {
  if (key) _store.delete(key)
  else _store.clear()
}

// ===== 读取侧纯函数：尾部与历史合并 + 缺口检测 =====

export interface MergedTail {
  /** 应写到图表序列的 bar（升序；最后一根为最新 forming） */
  applyBars: KlineBar[]
  /** applyBars 最后一根（调用方滚屏/修补用） */
  chartBar: KlineBar
  /** 历史 + 尾部的完整序列（指标/波段计算用） */
  mergedBars: KlineBar[]
}

/**
 * 历史 + 累积尾部合并：
 * - 首根与历史最后一根同时间：mergeRealtimeBar 合入历史末根
 * - 晚于历史：升序接在尾部
 * 空入参返回 null（调用方跳过本帧）。
 */
export function mergeTailWithHistory(
  currentBars: KlineBar[],
  tailBars: KlineBar[],
  period: KlinePeriod,
): MergedTail | null {
  if (!currentBars.length || !tailBars.length) return null
  const lastBar = currentBars[currentBars.length - 1]
  const lastT = normalizeBarTime(period, lastBar.time)
  const head = tailBars[0]
  const rest = tailBars.slice(1)
  const headMerged =
    normalizeBarTime(period, head.time) === lastT
      ? mergeRealtimeBar(lastBar, head)
      : head
  const applyBars = [headMerged, ...rest]
  const mergedBars =
    normalizeBarTime(period, head.time) === lastT
      ? [...currentBars.slice(0, -1), ...applyBars]
      : [...currentBars, ...applyBars]
  return {
    applyBars,
    chartBar: applyBars[applyBars.length - 1],
    mergedBars,
  }
}

/** 周期 → 分钟数（缺口判定用；1d/tick 不参与） */
const GAP_PERIOD_MINUTES: Partial<Record<KlinePeriod, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
}

/**
 * 超过 6 小时的跳变视为交易时段边界（隔夜/午休跨段），不按缺口处理
 */
const GAP_MAX_MINUTES = 6 * 60

/**
 * 尾段缺口检测：历史尾键与累积尾键之间的时间跳变超过 2 个周期且在
 * 时段边界上限内，视为中间缺根（WS 丢帧或服务端 rt 源断档），返回
 * 缺口签名 `${prevT}=>${t}` 供调用方触发单周期 force 重拉自愈；
 * 同一签名只处理一次，重拉后缺口进入历史序列即不再出现。
 */
export function detectTailGap(
  period: KlinePeriod,
  lastT: string,
  tailBars: KlineBar[],
): string | null {
  const minutes = GAP_PERIOD_MINUTES[period]
  if (!minutes || !lastT || !tailBars.length) return null
  let prevT = lastT
  for (const b of tailBars) {
    const t = normalizeBarTime(period, b.time)
    if (!t) continue
    const gapMin = (toTimestamp(t) - toTimestamp(prevT)) / 60
    if (gapMin > minutes * 2 && gapMin <= GAP_MAX_MINUTES) {
      return `${prevT}=>${t}`
    }
    prevT = t
  }
  return null
}

// ===== 浏览器侧：WS 帧直达累积器（不经 React 调度） =====
// websocket.ts 零运行时依赖，node --test 下加载无副作用；
// 订阅挂在模块级，每个 JS 运行时只注册一次，先于首帧生效。

if (typeof window !== "undefined") {
  getMarketWebSocket().onMessage((message) => {
    if (message?.type === "kline" && Array.isArray(message.data)) {
      offerRtFrames(
        message.data as Array<{
          symbol?: unknown
          period?: unknown
          bar?: unknown
        }>,
      )
    }
  })
}
