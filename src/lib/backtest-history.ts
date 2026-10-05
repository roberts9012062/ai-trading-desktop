/** 桌面预取回测数据；服务器只计算，不再下载/转发行情。 */
import type { BacktestRunPayload } from "./backtest-api"
import { fetchBacktestBars } from "./local-backtest"
import { latestOkxArchiveDay, okxArchiveDayStart, okxArchiveDate } from "./okx-history"
import { latestBinanceArchiveDay } from "./binance-futures"

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
  const warmupDays = Math.max(1, Math.floor(120 / (1440/minutes)) + 1)
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
