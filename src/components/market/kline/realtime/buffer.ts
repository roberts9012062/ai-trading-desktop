/**
 * 实时 K 线纯函数（自 use-realtime-kline.ts 抽出）
 *
 * forming bar 新鲜度判定、最新价修补、lightweight-charts 回写拒绝识别
 * 与逐根写入；历史+实时尾部的累积与合并见 ./accumulator.ts（随 WS 帧
 * 同步累积，与本模块的渲染期消费解耦）。
 */

import type { ISeriesApi } from "lightweight-charts"
import type { MutableRefObject } from "react"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, toTimestamp } from "../utils"

/** 分钟周期 → 分钟数（rt 桶新鲜度判据用） */
const PERIOD_MINUTES: Partial<Record<KlinePeriod, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240,
}

/**
 * realtime bar 是否仍是当前交易时段的 forming bar：
 * bar 起点 + 周期 + 3 分钟宽限覆盖当前时刻；日线给 40 小时（跨周末）。
 *
 * 陈旧 rt（昨夜末根）不得作为 quote 修补的基准——开盘瞬间 quote 先于
 * 新 K 线帧到达时，跳空价会被画进昨夜最后一根 K 线（2026-08-25 09:00
 * 实测）。陈旧时跳过修补，等待 kline:realtime 帧到位后再动。
 */
export function realtimeBarFresh(period: KlinePeriod, rtTime: string): boolean {
  const start = toTimestamp(rtTime)
  if (!Number.isFinite(start) || start <= 0) return false
  const nowSec = Math.floor(Date.now() / 1000)
  if (period === "1d") return nowSec - start < 40 * 3600
  const minutes = PERIOD_MINUTES[period]
  if (!minutes) return false
  return start + (minutes + 3) * 60 > nowSec
}

/**
 * 「历史尾部之后的实时 bar 累积」职责已迁至 ./accumulator.ts：随 WS 帧
 * 在消息回调里同步累积，不再依赖 React 提交消费。旧 ref 缓冲方案里，
 * 后台标签节流/渲染饥饿会让两次提交间的帧被丢——已收盘 bar 永久缺失
 * 且盘中无自愈，波段/指标在残缺序列上凑不出右侧确认条件，只能刷新
 * 页面补全历史（2026-09-10 根治）。
 */

/**
 * 用最新价修补当前 bar。
 * 仿真/脏 quote 若偏离本 bar 过多，拒绝改 H/L/C，避免整根 K 被拉飞。
 */
export function patchBarWithPrice(bar: KlineBar, lastPrice: number): KlineBar {
  if (!lastPrice || lastPrice <= 0) return bar
  const ref = Number(bar.close) || Number(bar.open) || 0
  if (ref > 0) {
    // 相对本 bar 收盘价偏离超过 3% 视为脏数据（期货单 bar 极少如此）
    const dev = Math.abs(lastPrice - ref) / ref
    if (dev > 0.03) return bar
  }
  return {
    ...bar,
    close: lastPrice,
    high: Math.max(bar.high, lastPrice),
    low: Math.min(bar.low, lastPrice),
  }
}

/**
 * lightweight-charts 拒绝回写旧时间 bar 的断言（series.update 只允许
 * 追加或改最后一条）。历史重拉/翻桶边界让 series 尾部领先于当前 rt
 * 帧时，每帧 update 都会被拒——图表冻结但 WS/store 全活着（2026-08-26
 * 复市实测冻结 6.8 分钟，靠下一次 REST 重拉 setData 才自愈）。
 */
export function isOldestDataError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Cannot update oldest data")
  )
}

/** 把一根 bar 增量写进蜡烛 + 成交量 series */
export function applyBarToSeries(
  series: ISeriesApi<"Candlestick">,
  volumeRef: MutableRefObject<ISeriesApi<"Histogram"> | null>,
  chartBar: KlineBar,
  period: KlinePeriod,
): void {
  series.update({
    time: formatChartTime(period, chartBar.time),
    open: chartBar.open,
    high: chartBar.high,
    low: chartBar.low,
    close: chartBar.close,
  })
  const volSeries = volumeRef.current
  if (volSeries) {
    volSeries.update({
      time: formatChartTime(period, chartBar.time),
      value: chartBar.volume,
      color:
        chartBar.close >= chartBar.open
          ? "rgba(239,68,68,0.3)"
          : "rgba(34,197,94,0.3)",
    })
  }
}
