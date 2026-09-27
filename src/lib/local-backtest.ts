/**
 * 本地回测(Pyodide)门面 —— K 线拉取 + Worker RPC
 *
 * 数据:分页回溯拉取 K 线直到覆盖 start_date 或无更多,直连 Binance 公开数据域
 * data-api.binance.vision(getBinanceKlineApi 与原服务端 getKlineApi 同契约:
 * {bars, has_more} + endTime 闭区间回溯),在客户端注入本地内核计算。
 * 内核:public/pykernel(worker 从 CDN 加载 Pyodide 后按清单写入虚拟 FS);
 * worker 单例由 py-worker.ts 管理(回测/因子共用)。
 */

import { getChannelKlineApi, normalizeChannel, DEFAULT_KLINE_CHANNEL, type KlineChannelId } from "@/lib/kline-channels"
import { enrichGateBars } from "@/lib/gate-futures"
import { enrichBinanceFuturesBars } from "@/lib/binance-futures"
import { ensurePyWorker } from "@/lib/py-worker"
import type { KlineBar, KlinePeriod } from "@/types"

export interface LocalBacktestPayload {
  symbol: string
  timeframe: string
  start_date: string
  end_date: string
  strategy_type: string
  strategy_params?: Record<string, unknown>
  side_mode?: string
  fixed_qty?: number
  initial_cash?: number
  close_rules?: Record<string, unknown>
  stop_rules?: Record<string, unknown>
  multi_segment?: boolean
  segment_count?: number
  /** 数据渠道(okx/binance_spot/gate_spot;缺省 binance_spot) */
  data_channel?: string
  [key: string]: unknown
}

/** 分页上限(防失控守卫,非数据边界):服务端 2026-09-01 修复连续合约分钟
 *  深回溯后,has_more=false 已是可信的自然终止信号(品种上市日),翻页会
 *  提前停住。150 页×500=7.5 万根:覆盖 rb 15m 全量(2009 上市,≈66,900
 *  根/134 页);更早上市品种(2005 起)15m 全量≈165 页会触发截断报错,
 *  届时缩小区间或上调本值。 */
export const KLINE_MAX_PAGES = 150

/** 拉取 [start_date, end_date] 区间的 K 线(分页回溯,上限防失控)。
 *  stopInfo.truncated 在耗尽 maxPages 仍未能覆盖 startDate 时置 true
 *  (仍有更老数据但被页数上限挡住),由调用方决定报错——不静默截断。
 *  onProgress 每页回调一次(深历史全量拉取约 1~2 分钟,供 UI 进度提示)。 */
export async function fetchBacktestBars(
  symbol: string,
  timeframe: KlinePeriod | string,
  startDate: string,
  endDate: string,
  maxPages = KLINE_MAX_PAGES,
  stopInfo?: { truncated: boolean },
  onProgress?: (msg: string) => void,
  channel: KlineChannelId = DEFAULT_KLINE_CHANNEL,
): Promise<KlineBar[]> {
  const all: KlineBar[] = []
  let endTime: string | undefined = undefined
  let stoppedEarly = false
  for (let page = 0; page < maxPages; page++) {
    const resp = await getChannelKlineApi(symbol, timeframe, { limit: 500, endTime }, channel)
    const bars = (resp.bars ?? []) as KlineBar[]
    if (bars.length === 0) {
      stoppedEarly = true
      break
    }
    all.unshift(...bars)
    onProgress?.(`拉取 K 线数据…已 ${all.length} 根,回溯至 ${String(bars[0].time).slice(0, 10)}`)
    if (!resp.has_more) {
      stoppedEarly = true
      break
    }
    const oldest = bars[0].time
    if (oldest.slice(0, 10) <= startDate) {
      stoppedEarly = true
      break
    }
    endTime = oldest
  }
  if (stopInfo) stopInfo.truncated = !stoppedEarly
  // 分页边界去重 + 升序排序:服务端 end_time 为闭区间时,相邻两页各含同一根
  // 边界 bar。重复 bar 会在 next_ret 里产生一根 0 收益、使时间序列非严格递增,
  // 污染特征矩阵与所有下游回测/搜索计算
  const byTime = new Map<string, KlineBar>()
  for (const b of all) byTime.set(String(b.time), b)
  const deduped = [...byTime.values()].sort((a, b) => {
    const ta = String(a.time)
    const tb = String(b.time)
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
  const start = startDate.slice(0, 10)
  const end = endDate.slice(0, 10)
  const selected = deduped.filter((b) => {
    const d = String(b.time).slice(0, 10)
    return d >= start && d <= end
  })
  if (channel === "gate_usdt") {
    onProgress?.("直连 Gate 补充历史资金费率与持仓统计…")
    return enrichGateBars(symbol, timeframe, selected)
  }
  if (channel === "binance_usdt") {
    onProgress?.("直连 Binance 补充永续资金费率…")
    return enrichBinanceFuturesBars(symbol, selected, onProgress)
  }
  return selected
}

/** 本地运行回测,返回与服务端 /api/backtest/run 同构的报告 */
export async function runBacktestLocal(
  payload: LocalBacktestPayload,
  onProgress?: (msg: string) => void,
): Promise<Record<string, unknown>> {
  onProgress?.("拉取 K 线数据…")
  const stopInfo = { truncated: false }
  const bars = await fetchBacktestBars(
    payload.symbol,
    payload.timeframe,
    payload.start_date,
    payload.end_date,
    KLINE_MAX_PAGES,
    stopInfo,
    onProgress,
    normalizeChannel(payload.data_channel),
  )
  if (stopInfo.truncated) {
    throw new Error(
      `K 线拉取达到 ${KLINE_MAX_PAGES} 页上限仍未能覆盖 ${String(payload.start_date).slice(0, 10)},请缩小区间后重试`,
    )
  }
  if (bars.length === 0) throw new Error("该区间没有可用的 K 线数据")
  onProgress?.(`本地引擎计算中(${bars.length} 根 K)…`)
  return (await ensurePyWorker().run(payload, bars)) as Record<string, unknown>
}
