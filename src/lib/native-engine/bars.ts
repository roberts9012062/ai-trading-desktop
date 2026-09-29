import type { BarsColumns, BarsMetadata } from "./types"
import { NativeEngineError } from "./ipc"

export type NativeBar = { time?: unknown; close?: number }

/** Numeric series use f64 msgpack columns; original calendar strings survive. */
export function packNativeBars(bars: NativeBar[], limit: BarsMetadata["max_bars"], snapshotId?: string): {
  columns: BarsColumns; metadata: BarsMetadata
} {
  if (bars.length < 2) throw new NativeEngineError("K 线至少需要 2 根", "BAR_LIMIT")
  if (bars.length > limit) throw new NativeEngineError(`区间过大(${bars.length} 根)，本机上限 ${limit} 根，请缩小区间`, "BAR_LIMIT")
  const numeric = new Set<string>()
  for (const bar of bars) for (const [key, value] of Object.entries(bar)) {
    if (key !== "time" && (typeof value === "number" || typeof value === "boolean")) numeric.add(key)
  }
  const columns: BarsColumns = { time_idx: new Float64Array(bars.length) }
  for (const key of numeric) columns[key] = new Float64Array(bars.length)
  const strings: Record<string, Array<string | null>> = {}
  for (const key of ["time", "market_source", "_factor_market"]) {
    // time 覆盖服务端按 time_idx 重建的 ISO 串:混合批次会产生 null 行盖掉有效重建值,
    // 因此仅当整列都是原始字符串时才发送;其余列 null 即"该行无此元数据",语义正确。
    const column = key === "time" ? bars.every(bar => typeof (bar as Record<string, unknown>)[key] === "string")
      : bars.some(bar => typeof (bar as Record<string, unknown>)[key] === "string")
    if (column) strings[key] = []
  }
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Record<string, unknown>
    const time = typeof bar.time === "number" ? bar.time : new Date(String(bar.time)).getTime()
    if (!Number.isFinite(time)) throw new NativeEngineError(`第 ${i + 1} 根 K 线时间无效`, "INVALID_BARS")
    columns.time_idx[i] = time
    for (const key of numeric) columns[key][i] = typeof bar[key] === "number" || typeof bar[key] === "boolean" ? Number(bar[key]) : NaN
    for (const [key, values] of Object.entries(strings)) values.push(typeof bar[key] === "string" ? String(bar[key]) : null)
  }
  if (!columns.close) throw new NativeEngineError("K 线缺少收盘价", "INVALID_BARS")
  return { columns, metadata: { count: bars.length, max_bars: limit,
    ...(snapshotId ? { snapshot_id: snapshotId } : {}), string_columns: strings } }
}
