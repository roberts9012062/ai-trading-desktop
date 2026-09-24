/**
 * Binance 实时 K 线轮询喂料器 —— 替代服务端 WS kline:realtime 的 K 线推送
 *
 * K 线数据全面直连国内可达的 data-api.binance.vision,不经服务器转发:
 * - 历史/翻页:api.ts 的 getKlineApi/getKlineBundleApi(委托 binance-kline)
 * - 形成中 bar 与刚收盘 bar 的最终态:本模块按 3s 轮询各活跃组合最近 2 根,
 *   经 offerRtBar 喂入 realtime/accumulator——下游 use-realtime-kline 与
 *   图表/指标/波段链路零改动(与服务端推送共用同一条累积路径)。
 *
 * 自适应活跃集合:只轮询「最近被 readRtTail 读取」的 symbol×period(读取即
 * 注册活跃,见 accumulator.readRtTail),图表不在看的组合 30s 后自动停轮;
 * 零组件接线,由 use-kline-history 顶部副作用 import 启动。
 *
 * 与服务端 kline:realtime 推送的关系:若后端仍在推,两源帧经
 * mergeRealtimeBar 版本号守卫合并,无乱序/回退风险;桌面端默认不再依赖它。
 * tick 分时(逐笔序列)不走本模块(仍由后端 WS 提供)。
 */
import { getBinanceKlineApi } from "@/lib/binance-kline"
import { listActiveRtKeys, offerRtBar } from "@/components/market/kline/realtime/accumulator"

/** 轮询间隔(盯盘级实时性;Binance klines 权重极低,无压力) */
const POLL_MS = 3_000
/** 组合闲置多久后停止轮询(读取侧停止触碰即视为无消费者) */
const IDLE_MS = 30_000
/** 连续失败退避:3s → 6s → 15s 封顶,成功即恢复 */
const BACKOFF_STEPS = [POLL_MS, 2 * POLL_MS, 5 * POLL_MS]

let timer: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0

async function pollOnce(): Promise<void> {
  const keys = listActiveRtKeys(IDLE_MS)
  if (keys.length === 0) return
  await Promise.all(
    keys.map(async ({ symbol, period }) => {
      if (period === "tick") return
      try {
        const page = await getBinanceKlineApi(symbol, period, { limit: 2 })
        for (const bar of page.bars) offerRtBar(symbol, period, bar)
      } catch {
        // 单组合失败不拖累其他组合;整体退避由下方 consecutiveFailures 承担
      }
    }),
  )
}

function currentDelay(): number {
  return BACKOFF_STEPS[Math.min(consecutiveFailures, BACKOFF_STEPS.length - 1)]
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    try {
      await pollOnce()
      consecutiveFailures = 0
    } catch {
      consecutiveFailures += 1
    } finally {
      schedule()
    }
  }, currentDelay())
}

/** 启动轮询(幂等) */
export function startBinanceFormingFeed(): void {
  if (typeof window === "undefined" || timer) return
  schedule()
}

// 浏览器/WebView 侧自动启动(与 accumulator 的 WS 接线同款模式);
// node --test 纯逻辑测试环境无 window,天然 no-op。
if (typeof window !== "undefined") {
  startBinanceFormingFeed()
}
