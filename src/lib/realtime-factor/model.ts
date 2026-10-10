import type { KlineBar } from '@/types'

export type Cadence = 1 | 2 | 3 | 4 | 5
export type Action = 'hold' | 'close' | 'open_long' | 'open_short'
export interface Analysis {
  id: string
  at: number
  marketAt: number
  price: number
  score: number | null
  action: Action
  reason: string
  status: string
  orderId?: string | null
}

export function appendAnalysis<T>(rows: readonly T[], row: T): T[] {
  return [row,...rows].slice(0,50)
}

export function mergeCandle(rows: readonly KlineBar[], candle: KlineBar, cap: number): KlineBar[] {
  const previous=rows.find(b=>b.time===candle.time)
  if (previous?.is_closed && !candle.is_closed) return [...rows]
  const last=rows.filter(b=>b.time<candle.time).at(-1) as (KlineBar&Record<string,unknown>)|undefined
  const inherited:Record<string,unknown>={}
  for(const key of ['open_interest','funding_rate','funding_time','derivatives_time','lsr','long_short_ratio','taker_ratio','xspread','btc_ret']) {
    if(last?.[key]!=null)inherited[key]=last[key]
  }
  const next={...inherited,...previous,...candle}
  return [...rows.filter(b=>b.time!==candle.time),next].sort((a,b)=>a.time.localeCompare(b.time)).slice(-cap)
}

/** Refresh derivatives from the server, retaining newer local candle data. */
export function refreshEnrichment(seed: readonly KlineBar[], local: readonly KlineBar[], cap: number): KlineBar[] {
  const enriched=new Map(seed.map(bar=>[bar.time,bar]))
  let rows=[...seed]
  for(const bar of local) {
    const merged={...bar,...enriched.get(bar.time),time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,is_closed:bar.is_closed}
    for(const key of ['quote_volume','trade_count','taker_buy_volume','taker_buy_quote_volume'] as const) {
      if(bar[key]!=null)Object.assign(merged,{[key]:bar[key]})
    }
    rows=mergeCandle(rows,merged,cap)
  }
  return rows
}

export function healthy(now: number, computedAt: number, marketAt: number, interval: number): boolean {
  return computedAt>0 && marketAt>0 && now-computedAt<=interval*1000+1500 && now-marketAt<5000
}

interface IntentTask {
  side_mode: string
  close_rules: { factor_exit?: {mode?: string; long_threshold?: number; short_threshold?: number} | null }
  position_qty?: number | null
  position_direction?: string | null
}
export function intentForScore(task: IntentTask, score: number): Action {
  const has=(task.position_qty??0)>0, dir=task.position_direction
  const cfg=task.close_rules.factor_exit
  if (has && cfg) {
    const lt=cfg.long_threshold??(cfg.mode==='reach'?0.8:0.15), st=cfg.short_threshold??(cfg.mode==='reach'?0.8:0.15)
    if (cfg.mode==='reach' ? (dir==='long'&&score>=lt || dir==='short'&&score<=-st) : (dir==='long'&&score<=lt || dir==='short'&&score>=-st)) return 'close'
  }
  if (score>0.3 && task.side_mode!=='short_only') {
    if (has) return dir==='short'?'close':'hold'
    if (cfg?.mode==='reach' && score>=(cfg.long_threshold??0.8)) return 'hold'
    return 'open_long'
  }
  if (score< -0.3 && task.side_mode!=='long_only') {
    if (has) return dir==='long'?'close':'hold'
    if (cfg?.mode==='reach' && score<=-(cfg.short_threshold??0.8)) return 'hold'
    return 'open_short'
  }
  return has && Math.abs(score)<0.05?'close':'hold'
}
