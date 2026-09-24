/**
 * 跨品种验证 —— 同板块伙伴品种解析与 K 线预加载(深挖强化)
 *
 * 流程:内核 cross_peer_symbols 模式按板块映射取同板块流动性前 N 个
 * 伙伴品种(单一事实源,product_sectors)→ 逐个拉 K 线(与主任务同区间)
 * → 有效根数 ≥120(内核 MIN_TEST_BARS)的组装为 cross_peers 注入
 * MiningConfig,严格筛要求 ≥⌈K/2⌉ 个伙伴 sortino>0 才放行冠军。
 *
 * 拉取失败/数据不足的伙伴自动剔除;全部不可用抛错(用户明确开启了开关,
 * 静默空转会误导)。
 */

import { fetchBacktestBars, KLINE_MAX_PAGES } from "@/lib/local-backtest"
import { defaultFactorRangeFor } from "@/components/factor-lab/factor-range-limits"

/** 内核 cross_peers 的最小有效根数(walk_forward.MIN_TEST_BARS 同值) */
export const MIN_PEER_BARS = 120

export interface CrossPeerBundle {
  /** [[品种代码, bars], ...] —— 与内核 SearchConfig.cross_peers 同构 */
  peers: Array<[string, Array<Record<string, unknown>>]>
  sector: string | null
  /** 供 UI 提示的结果摘要 */
  note: string
}

interface PeerSymbolsResult {
  code: string
  sector: string | null
  peers: string[]
}

/** 解析伙伴并预加载 K 线;count 钳 [1,4],板块不足自动减少 */
export async function loadCrossPeers(opts: {
  symbol: string
  timeframe: string
  count: number
  onProgress?: (msg: string) => void
}): Promise<CrossPeerBundle> {
  const count = Math.max(1, Math.min(4, Math.floor(opts.count)))
  const { ensurePyWorker } = await import("@/lib/py-worker")
  // 首次调用触发 Pyodide 冷加载(CDN 下载 Pyodide+numpy,慢网下可超 30s),
  // 超时须容纳冷加载;之后的所有内核调用都在毫秒级
  opts.onProgress?.("初始化本地计算内核（首次需下载组件，可能约 1 分钟）…")
  const info = (await ensurePyWorker().factorRun(
    { mode: "cross_peer_symbols", symbol: opts.symbol, count },
    [],
    120_000,
  )) as PeerSymbolsResult
  if (!info?.peers?.length) {
    throw new Error(
      `品种 ${info?.code ?? opts.symbol} 无同板块验证伙伴(无板块映射或板块内无其他品种)`,
    )
  }
  // 区间与 local-runner.create 的缺省区间同源(defaultFactorRangeFor)
  const range = defaultFactorRangeFor(opts.timeframe, new Date())
  const peers: Array<[string, Array<Record<string, unknown>>]> = []
  for (const code of info.peers) {
    opts.onProgress?.(`拉取跨品种验证伙伴 ${code} 的 K 线…`)
    try {
      const bars = await fetchBacktestBars(
        code,
        opts.timeframe,
        range.start,
        range.end,
        KLINE_MAX_PAGES,
        undefined,
        undefined,
      )
      if (bars.length >= MIN_PEER_BARS) {
        peers.push([code, bars as unknown as Array<Record<string, unknown>>])
      }
    } catch {
      // 单个伙伴失败剔除,不阻断其余
    }
  }
  if (!peers.length) {
    throw new Error("同板块伙伴的 K 线数据均不可用(不足 120 根或拉取失败),请关闭跨品种验证或稍后重试")
  }
  return {
    peers,
    sector: info.sector,
    note: `跨品种验证就绪:${info.sector ?? "同板块"} ${peers.map((p) => p[0]).join("/")}`,
  }
}
