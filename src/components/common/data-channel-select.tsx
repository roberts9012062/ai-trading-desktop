"use client"

/** 历史数据渠道选择（回测 / 因子实验室 / 超级因子挖掘共用）
 *
 * 选渠道后自动探测该 (渠道, 品种, 周期) 的可用历史范围，
 * 通过 onRange 回调交给页面 clamp 日期选择器 —— 每个渠道的
 * 历史深度不同（如 Binance 现货 2017-08 起）。
 */

import { useEffect, useRef, useState } from "react"
import {
  getChannelRange,
  getHistoryChannels,
  type ChannelRange,
  type HistoryChannel,
} from "@/lib/history-channels"

let _channelsCache: HistoryChannel[] | null = null

export function DataChannelSelect(props: {
  value: string
  onChange: (channel: string) => void
  /** 品种（规范符号）；为空时不探测范围 */
  symbol?: string | null
  timeframe?: string
  /** 范围探测结果（探测中/失败为 null） */
  onRange?: (range: ChannelRange | null) => void
  /** 追加的额外渠道（如超级因子的 future 期货库） */
  extraChannels?: HistoryChannel[]
  label?: string
  className?: string
}): React.JSX.Element {
  const {
    value,
    onChange,
    symbol,
    timeframe,
    onRange,
    extraChannels,
    label = "数据渠道",
    className,
  } = props
  const [channels, setChannels] = useState<HistoryChannel[]>(
    () => _channelsCache ?? extraChannels ?? []
  )
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onRangeRef = useRef(onRange)
  onRangeRef.current = onRange

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (_channelsCache !== null) {
        if (!cancelled && extraChannels) {
          setChannels([...extraChannels, ..._channelsCache])
        }
        return
      }
      try {
        const list = await getHistoryChannels()
        _channelsCache = list
        if (!cancelled) {
          setChannels(extraChannels ? [...extraChannels, ...list] : list)
        }
      } catch {
        /* 列表加载失败时保留 extraChannels，不阻塞表单 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [extraChannels])

  useEffect(() => {
    // 渠道/品种/周期任一变化即重探范围（okx 之外的渠道才需要探测；
    // okx 也统一探测，让时间尺精确到实际数据起点）
    if (!symbol || !timeframe) return
    let cancelled = false
    void (async () => {
      setProbing(true)
      setError(null)
      try {
        const range = await getChannelRange(value, symbol, timeframe)
        if (!cancelled) onRangeRef.current?.(range)
      } catch (e) {
        if (!cancelled) {
          onRangeRef.current?.(null)
          setError(e instanceof Error ? e.message : "范围探测失败")
        }
      } finally {
        if (!cancelled) setProbing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [value, symbol, timeframe])

  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <span className="text-xs text-[var(--text-secondary)]">{label}</span>
        {probing && (
          <span className="text-[10px] text-[var(--text-muted)]">
            探测历史范围…
          </span>
        )}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 mt-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
      >
        {channels.length === 0 && <option value={value}>{value}</option>}
        {channels.map((c) => (
          <option key={c.id} value={c.id} title={c.note}>
            {c.name}
          </option>
        ))}
      </select>
      {error && (
        <p className="text-[10px] text-[var(--accent-danger)] mt-0.5">{error}</p>
      )}
    </div>
  )
}
