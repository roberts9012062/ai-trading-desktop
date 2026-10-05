/** 桌面预取回测数据；服务器只计算，不再下载/转发行情。 */
import type { BacktestRunPayload } from "./backtest-api"
import { fetchBacktestBars } from "./local-backtest"
import { latestOkxArchiveDay, okxArchiveDayStart, okxArchiveDate } from "./okx-history"
import { latestBinanceArchiveDay } from "./binance-futures"
import quantOps from "./quant-window-ops.json"

const TF_MINUTES: Record<string, number> = {"1m":1,"5m":5,"15m":15,"30m":30,"60m":60,"1d":1440}
const DAY = 86400000

/** 与服务器 swing_pro_data_tf 对齐，较短周期才能聚合较长周期。 */
export function backtestDataTimeframe(body: BacktestRunPayload): string {
  const main = body.timeframe
  if (body.strategy_type !== "swing_pro") return main
  const params = body.strategy_params ?? {}
  let other = String(params.htf_tf ?? "").trim().toLowerCase()
  if (!TF_MINUTES[other]) {
    const factor = Math.trunc(Number(params.htf_factor ?? 1))
    other = factor > 1 ? Object.keys(TF_MINUTES).reduce((best, tf) =>
      Math.abs(TF_MINUTES[tf]! - TF_MINUTES[main]!*factor) < Math.abs(TF_MINUTES[best]! - TF_MINUTES[main]!*factor) ? tf : best, "1m") : ""
  }
  return other && TF_MINUTES[other]! < TF_MINUTES[main]! ? other : main
}

/** Mirrors the server signal window; this also controls history downloaded before start. */
export function backtestWarmupBars(body: BacktestRunPayload): number {
  const p = body.strategy_params ?? {}, kind = body.strategy_type
  const n = (key: string, fallback: number) => Math.trunc(Number(p[key]) || fallback)
  if (kind === "ai" || kind === "swing_pivot" || kind === "swing_pivot_v2") return 120
  if (kind === "ma_cross") {
    const slow = Math.max(2, n("slow_period",20), n("fast_period",5)+1)
    return Math.max(240, slow+1, p.ma_type === "ema" ? slow*5 : 0)
  }
  if (kind === "n_breakout") return Math.max(240,n("lookback",n("lookback_period",20))+1)
  if (kind === "macd_cross") {
    const fast = Math.max(2,Math.min(100,n("fast_period",12)))
    const slow = Math.max(3,Math.min(200,n("slow_period",26)),fast+1)
    const signal = Math.max(2,Math.min(100,n("signal_period",9)))
    return Math.max(240,(slow+signal)*5+2)
  }
  if (kind === "band_swing") return Math.max(240,n("period",n("lookback",20))+1)
  if (kind === "kdj_cross") return Math.max(240,n("n_period",9)+10*(n("k_period",3)+n("d_period",3)))
  if (kind === "factor") {
    const raw = p.factor_tokens as number[] | number[][] | undefined
    const groups: number[][] = raw?.length ? (Array.isArray(raw[0]) ? raw as number[][] : [raw as number[]]) : []
    const norm = Math.max(200,Math.ceil(1440/(TF_MINUTES[body.timeframe] ?? 1440)))
    const history = (tokens: number[]) => {
      const offset = tokens.some(t => t >= 128) ? 128 : 64
      return tokens.reduce((sum,t) => {
        const name = t >= offset ? quantOps[t-offset] : undefined
        const digits = name?.match(/\d+/g)
        return sum + (name ? (digits?.length ? Number(digits.at(-1)) : 20) : 0)
      },0)
    }
    return Math.min(10000,Math.max(600,2*norm+180+Math.max(0,...groups.map(history))))
  }
  if (kind === "swing_pro") {
    const main = TF_MINUTES[body.timeframe] ?? 5
    const other = String(p.htf_tf ?? "").trim().toLowerCase()
    const factor = Math.trunc(Number(p.htf_factor ?? 1))
    const long = TF_MINUTES[other] ?? (factor > 1 ? Object.values(TF_MINUTES).reduce((best,m) => Math.abs(m-main*factor)<Math.abs(best-main*factor) ? m : best,1) : main)
    return Math.min(10000,240*Math.max(1,Math.floor(Math.max(main,long)/Math.min(main,long))))
  }
  if (kind === "strength_entry" || kind === "strength_entry_v2") {
    return Math.max(240,100+n("period",14)+n("smooth",3)+n("smooth2",1)+n("trend_ma_period",10)+n("rebound_lookback",10)+n("atr_period",14)+n("exhaust_window",10)+n("cooldown",3))
  }
  return 240
}

export async function prepareBacktestHistory(body: BacktestRunPayload, progress?: (msg: string) => void) {
  const tf = backtestDataTimeframe(body), minutes = TF_MINUTES[tf]
  if (!minutes) throw new Error("不支持的回测数据周期")
  const channel = body.data_channel === "binance_usdt" ? "binance_usdt" : "okx"
  const label = channel === "okx" ? "OKX" : "Binance USDT 永续"
  const floorDate = channel === "okx" ? "2023-07-01" : "2019-09-02"
  const floor = okxArchiveDayStart(floorDate)
  const latest = channel === "okx" ? latestOkxArchiveDay() : latestBinanceArchiveDay()
  const start = okxArchiveDayStart(body.start_date), end = okxArchiveDayStart(body.end_date)
  if (!Number.isFinite(start) || !Number.isFinite(end) || okxArchiveDate(start) !== body.start_date || okxArchiveDate(end) !== body.end_date) throw new Error("回测日期非法")
  if (start < floor || end < start || body.end_date > latest) {
    throw new Error(`请选择 ${label} 已发布归档区间（${floorDate} 至 ${latest}）`)
  }
  const warmupDays = Math.max(1, Math.floor(backtestWarmupBars(body) / (1440/minutes)) + 1)
  const warmupStart = Math.max(floor, start - warmupDays*DAY)
  if ((end+DAY-warmupStart)/(minutes*60000) > 200000) throw new Error("回测数据超过20万根，请缩短区间或增大周期")
  const from = new Date(warmupStart+8*3600000).toISOString().slice(0,10)
  progress?.(`本机准备 ${label} 官方历史数据…`)
  const bars = await fetchBacktestBars(body.symbol, tf, from, body.end_date, undefined, undefined, progress, channel)
  if (!bars.length) throw new Error(`${label} 所选归档区间无数据，请缩短区间或更换品种`)
  progress?.(`${label} 本机数据 ${bars.length.toLocaleString()} 根已就绪，开始回测计算…`)
  return {...body, data_channel:channel, history_source:channel === "okx" ? "okx_archive_v1" : "binance_um_archive_v1", history_timeframe:tf,
    history_bars:bars.map(({time,open,high,low,close,volume}) => ({time,open,high,low,close,volume}))}
}
