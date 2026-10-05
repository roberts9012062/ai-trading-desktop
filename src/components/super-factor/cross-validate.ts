/**
 * 跨币种验证 —— 同板块伙伴币种解析与 K 线预加载(深挖强化)
 *
 * 流程:按板块映射取同板块前 N 个伙伴币种(桌面端优先内置加密宇宙的
 * sector 分组;宇宙外符号回退内核 cross_peer_symbols/product_sectors)
 * → 逐个拉 K 线(与主任务同区间,Binance 直连)
 * → 有效根数 ≥120(内核 MIN_TEST_BARS)的组装为 cross_peers 注入
 * MiningConfig,严格筛要求 ≥⌈K/2⌉ 个伙伴 sortino>0 才放行冠军。
 *
 * 拉取失败/数据不足的伙伴自动剔除;全部不可用抛错(用户明确开启了开关,
 * 静默空转会误导)。
 */

import { fetchBacktestBars, KLINE_MAX_PAGES } from "@/lib/local-backtest"
import { normalizeChannel } from "@/lib/kline-channels"
import { researchFactorRangeFor } from "@/components/factor-lab/factor-range-limits"
import { CRYPTO_ASSETS } from "@/data/crypto-universe"

/** 内核 cross_peers 的最小有效根数(walk_forward.MIN_TEST_BARS 同值) */
export const MIN_PEER_BARS = 120

/** 内置宇宙同板块伙伴解析:宇宙内的符号直接分组取前 N(跳过 Pyodide 冷加载);宇宙外返回 null */
function resolveLocalPeers(
  symbol: string,
  count: number,
): PeerSymbolsResult | null {
  const key = String(symbol || "").trim().toLowerCase()
  const self = CRYPTO_ASSETS.find((a) => a.code === key)
  if (!self) return null
  const peers = CRYPTO_ASSETS.filter(
    (a) => a.sector === self.sector && a.code !== key,
  )
    .slice(0, count)
    .map((a) => a.code)
  return { code: key, sector: self.sector, peers }
}

export interface CrossPeerBundle {
  /** [[币种代码, bars], ...] —— 与内核 SearchConfig.cross_peers 同构 */
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
  /** 数据渠道:伙伴 K 线与主任务同渠道 */
  channel?: string
  onProgress?: (msg: string) => void
}): Promise<CrossPeerBundle> {
  const count = Math.max(1, Math.min(4, Math.floor(opts.count)))
  // 伙伴解析本地化:优先用内置加密宇宙的板块分组(内核 product_sectors 是
  // qihuo 期货板块映射,无加密币种);宇宙外的符号回退内核逻辑
  let info: PeerSymbolsResult
  const local = resolveLocalPeers(opts.symbol, count)
  if (local) {
    info = local
  } else {
    const { ensurePyWorker } = await import("@/lib/py-worker")
    // 首次调用触发 Pyodide 冷加载(CDN 下载 Pyodide+numpy,慢网下可超 30s),
    // 超时须容纳冷加载;之后的所有内核调用都在毫秒级
    opts.onProgress?.("初始化本地计算内核（首次需下载组件，可能约 1 分钟）…")
    info = (await ensurePyWorker().factorRun(
      { mode: "cross_peer_symbols", symbol: opts.symbol, count },
      [],
      120_000,
    )) as PeerSymbolsResult
  }
  if (!info?.peers?.length) {
    throw new Error(
      `币种 ${info?.code ?? opts.symbol} 无同板块验证伙伴(无板块映射或板块内无其他币种)`,
    )
  }
  // 区间与 local-runner.create 的缺省区间同源(researchFactorRangeFor)
  const range = researchFactorRangeFor(opts.timeframe, opts.channel)
  const peers: Array<[string, Array<Record<string, unknown>>]> = []
  for (const code of info.peers) {
    opts.onProgress?.(`拉取跨币种验证伙伴 ${code} 的 K 线…`)
    try {
      const bars = await fetchBacktestBars(
        code,
        opts.timeframe,
        range.start,
        range.end,
        KLINE_MAX_PAGES,
        undefined,
        undefined,
        normalizeChannel(opts.channel),
      )
      if (bars.length >= MIN_PEER_BARS) {
        peers.push([code, bars as unknown as Array<Record<string, unknown>>])
      }
    } catch {
      // 单个伙伴失败剔除,不阻断其余
    }
  }
  if (!peers.length) {
    throw new Error("同板块伙伴的 K 线数据均不可用(不足 120 根或拉取失败),请关闭跨币种验证或稍后重试")
  }
  return {
    peers,
    sector: info.sector,
    note: `跨币种验证就绪:${info.sector ?? "同板块"} ${peers.map((p) => p[0]).join("/")}`,
  }
}
