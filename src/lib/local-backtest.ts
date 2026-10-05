/**
 * 本地回测(Pyodide)门面 —— K 线拉取 + Worker RPC
 *
 * 数据:fetchBacktestBars 是超级因子/因子实验室/历史回测共用的取数漏斗。
 * 直连渠道按 {bars, has_more} + endTime 闭区间回溯分页;**研究缓存**按
 * channel:symbol:timeframe 存整段深历史(含衍生字段),每次只增量拉缺口
 * (尾部通常仅最近几天,重叠 1 天自愈修订)再拼接——重复挖掘同币种取数
 * 从分钟级降到亚秒级;缓存可在个人页手动清理。
 * 内核:public/pykernel(worker 从 CDN 加载 Pyodide 后按清单写入虚拟 FS);
 * worker 单例由 py-worker.ts 管理(回测/因子共用)。
 */

import { getChannelKlineApi, normalizeChannel, DEFAULT_KLINE_CHANNEL, type KlineChannelId } from "@/lib/kline-channels"
import { enrichGateBars } from "@/lib/gate-futures"
import { enrichBinanceFuturesBars } from "@/lib/binance-futures"
import { mergeBarsPreferNew, readResearchKlines, writeResearchKlines } from "@/lib/research-kline-cache"
import { ensurePyWorker } from "@/lib/py-worker"
import type { KlineBar, KlinePeriod } from "@/types"
import { fetchOkxHistoryRange } from "@/lib/okx-history"
import { barTimeToMs } from "@/lib/binance-kline"

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
  /** 数据渠道(okx/binance_spot/gate_spot/gate_usdt/binance_usdt;缺省 binance_spot) */
  data_channel?: string
  [key: string]: unknown
}

/** 分页上限(防失控守卫,非数据边界):has_more=false 是可信的自然终止信号
 *  (品种上市日),翻页会提前停住。150 页×500=7.5 万根:覆盖 rb 15m 全量
 *  (2009 上市,≈66,900 根/134 页);更早上市品种 15m 全量≈165 页会触发
 *  截断报错,届时缩小区间或上调本值(归档渠道页=归档包,不受此约束)。 */
export const KLINE_MAX_PAGES = 150

/** 分页回溯拉取:从最新(或 untilEnd)往回翻到最旧一根 ≤ fromStart。
 *  返回原始 bars(未去重)与 truncated(耗尽 pages 仍未覆盖 fromStart)。 */
async function paginateBackward(
  symbol: string,
  timeframe: KlinePeriod | string,
  fromStart: string,
  untilEnd: string | undefined,
  maxPages: number,
  channel: KlineChannelId,
  onProgress?: (msg: string) => void,
): Promise<{ bars: KlineBar[]; truncated: boolean }> {
  const all: KlineBar[] = []
  let endTime = untilEnd
  let prevOldest = "" // okx 深探的进展标记(防同位置空转死循环)
  for (let page = 0; page < maxPages; page++) {
    const resp = await getChannelKlineApi(symbol, timeframe, { limit: 500, endTime }, channel)
    const bars = (resp.bars ?? []) as KlineBar[]
    if (bars.length === 0) return { bars: all, truncated: false }
    all.unshift(...bars)
    onProgress?.(`拉取 K 线数据…已 ${all.length} 根,回溯至 ${String(bars[0].time).slice(0, 10)}`)
    const oldest = bars[0].time
    if (!resp.has_more) {
      // okx 渠道后端首页 has_more 语义错误(实测 326 根即 false,但带
      // end_time 深翻可达数千根以上):未覆盖 fromStart 且仍有进展时,
      // 以最旧一根继续回探;空页/无进展才真正终止
      if (
        channel === "okx" &&
        oldest.slice(0, 10) > fromStart &&
        (!prevOldest || oldest < prevOldest)
      ) {
        prevOldest = oldest
        endTime = oldest
        continue
      }
      return { bars: all, truncated: false }
    }
    if (oldest.slice(0, 10) <= fromStart) return { bars: all, truncated: false }
    endTime = oldest
  }
  return { bars: all, truncated: true }
}

/** bar time(北京时间 naive)前移 n 天,用于尾部增量的重叠起点 */
function shiftBarDateDay(time: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(time.trim())
  if (!m) return time
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/**
 * 拉取 [start_date, end_date] 区间的 K 线(研究缓存感知:命中只增量拉缺口)。
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
  const start = startDate.slice(0, 10)
  const end = endDate.slice(0, 10)
  if (channel === "okx") {
    if (stopInfo) stopInfo.truncated = false
    // A separate official-file cache prevents reusing legacy server/Gate fallback bars.
    return fetchOkxHistoryRange(symbol,timeframe,barTimeToMs(start),barTimeToMs(`${end} 23:59:59`)+999,onProgress)
  }

  // ── 研究缓存:命中则只补缺口(尾部自愈重叠 1 天;头部按需回溯) ──
  const cached = await readResearchKlines(channel, symbol, timeframe)
  let base: KlineBar[] = cached ?? []
  let fetched: KlineBar[] = [] // 本次网络新拉的原始 bar(head+tail)
  let truncated = false
  // Monthly archives should start at the requested endpoint, not today's page:
  // a 2022 study must not download four years of unrelated perpetual data.
  const endpoint = channel === "binance_usdt" ? shiftBarDateDay(end, 1)+" 00:00:00" : undefined

  if (!base.length) {
    const r = await paginateBackward(symbol, timeframe, start, endpoint, maxPages, channel, onProgress)
    fetched = r.bars
    truncated = r.truncated
  } else {
    const firstT = String(base[0].time).slice(0, 10)
    const lastT = String(base[base.length - 1].time).slice(0, 10)
    const tailGap = end >= lastT // 请求触达缓存末根当天或之后 → 增量拉尾(顺带覆盖区间整体在缓存之后的情况)
    const headGap = start < firstT // 请求起点早于缓存开头
    if (tailGap) {
      // 尾部增量:从缓存末根前 1 天往新拉(重叠段按新拉覆盖,自愈修订)
      const overlapFrom = shiftBarDateDay(lastT, -1)
      onProgress?.(`本地缓存命中(${base.length} 根,至 ${lastT}),增量拉取最新 K 线…`)
      const r = await paginateBackward(symbol, timeframe, overlapFrom, endpoint, maxPages, channel, onProgress)
      fetched = r.bars
      truncated = r.truncated
    }
    if (headGap) {
      // 头部缺口:从缓存首根往回补到请求起点。拉到 0 根 = 缓存已达
      // 品种数据起点(如请求起点 2005 但币种 2017 上市),提示后按覆盖处理
      onProgress?.(`本地缓存命中(${base.length} 根,自 ${firstT}),回溯补齐更早 K 线…`)
      const r = await paginateBackward(symbol, timeframe, start, String(base[0].time), maxPages, channel, onProgress)
      if (r.bars.length === 0 && !r.truncated) {
        onProgress?.(`缓存已覆盖该品种全部可用历史(${firstT} 起上市),无需更早数据`)
      }
      fetched = mergeBarsPreferNew(fetched, r.bars)
      truncated = truncated || r.truncated
    }
    if (!tailGap && !headGap) {
      // 完全覆盖:零网络,直接切区间
      onProgress?.(`使用本地缓存 K 线(${base.length} 根,${firstT} ~ ${lastT}),无需下载`)
    }
  }
  if (stopInfo) stopInfo.truncated = truncated

  // 去重排序:分页边界闭区间会重复边界 bar;重复 bar 会在 next_ret 里产生
  // 一根 0 收益、污染特征矩阵与所有下游回测/搜索计算
  const byTime = new Map<string, KlineBar>()
  for (const b of fetched) byTime.set(String(b.time), b)
  const fetchedDedup = [...byTime.values()].sort((a, b) => (String(a.time) < String(b.time) ? -1 : 1))

  // 衍生数据补齐只对新拉段做(gate/binance 永续);缓存段已含资金费率等字段
  if (fetchedDedup.length) {
    if (channel === "gate_usdt") {
      onProgress?.("直连 Gate 补充历史资金费率与持仓统计…")
      const enriched = await enrichGateBars(symbol, timeframe, fetchedDedup)
      base = mergeBarsPreferNew(base, enriched)
    } else if (channel === "binance_usdt") {
      onProgress?.("直连 Binance 补充永续资金费率…")
      const enriched = await enrichBinanceFuturesBars(symbol, fetchedDedup, onProgress)
      base = mergeBarsPreferNew(base, enriched)
    } else {
      base = mergeBarsPreferNew(base, fetchedDedup)
    }
    // 整段回写(异步不阻塞返回;失败静默)
    void writeResearchKlines(channel, symbol, timeframe, base)
  }

  const selected = base.filter((b) => {
    const d = String(b.time).slice(0, 10)
    return d >= start && d <= end
  })
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
  onProgress?.(`本地引擎计算中(${bars.length} 根)…`)
  return (await ensurePyWorker().run(payload, bars)) as Record<string, unknown>
}
