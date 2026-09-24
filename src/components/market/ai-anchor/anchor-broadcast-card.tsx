"use client"

/**
 * AI 看盘主播播报卡片 —— 最新结论大卡与历史小卡复用
 */

import type { AnchorBroadcast } from "@/lib/ai-anchor-api"
import { contractName } from "@/lib/contract-names"

/** 做多红 / 做空绿（对齐大单 buy_color/sell_color 惯例）/ 中性灰 */
export function directionColor(direction: AnchorBroadcast["direction"]): string {
  if (direction === "long") return "#ef4444"
  if (direction === "short") return "#22c55e"
  return "var(--text-secondary)"
}

export function directionText(direction: AnchorBroadcast["direction"]): string {
  if (direction === "long") return "做多"
  if (direction === "short") return "做空"
  return "观望"
}

/** 播报时间 → 本地时区 "MM-DD HH:mm"(后端存 UTC,直接切片会差时区) */
export function formatBroadcastTime(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 价格显示（空值显示 -） */
function priceText(value: number | null): string {
  return value == null ? "-" : String(value)
}

/** 历史小卡：单行摘要（时间 + 方向 + 动作 + 一句话） */
export function AnchorBroadcastRow({
  broadcast,
}: {
  broadcast: AnchorBroadcast
}): React.JSX.Element {
  const time = formatBroadcastTime(broadcast.created_at)
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 border-b border-[var(--border)] last:border-0">
      <span className="text-[10px] font-num text-[var(--text-muted)] shrink-0 pt-0.5">
        {time}
      </span>
      <span
        className="text-[11px] font-bold shrink-0 pt-0.5"
        style={{ color: directionColor(broadcast.direction) }}
      >
        {directionText(broadcast.direction)}
      </span>
      <span className="text-[11px] text-[var(--text-secondary)] truncate">
        {broadcast.model_error
          ? broadcast.commentary
          : `${broadcast.action === "trade" ? "做单" : "观望"} · ${broadcast.commentary}`}
      </span>
    </div>
  )
}

/** 持仓建议文案/配色（hold=持有 add=加仓 reduce=减仓 close=离场） */
const POSITION_ADVICE_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  hold: { label: "持仓·持有", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  add: { label: "持仓·加仓", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  reduce: { label: "持仓·减仓", color: "#fb923c", bg: "rgba(251,146,60,0.12)" },
  close: { label: "持仓·离场", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
}

/** 最新结论大卡：方向 + 进场/止盈/止损 + 动作 + 关键价位 + 播报文案 */
export function AnchorBroadcastCard({
  broadcast,
}: {
  broadcast: AnchorBroadcast
}): React.JSX.Element {
  const levels = broadcast.key_levels ?? []
  const advice = broadcast.position_advice
  const adviceMeta = advice ? POSITION_ADVICE_META[advice.action] : null
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-base font-bold"
            style={{ color: directionColor(broadcast.direction) }}
          >
            {directionText(broadcast.direction)}
          </span>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{
              color: broadcast.action === "trade" ? "#f59e0b" : "var(--text-secondary)",
              backgroundColor:
                broadcast.action === "trade" ? "rgba(245,158,11,0.12)" : "var(--bg-tertiary)",
            }}
          >
            {broadcast.action === "trade" ? "建议做单" : "建议观望"}
          </span>
          {adviceMeta && advice && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ color: adviceMeta.color, backgroundColor: adviceMeta.bg }}
              title={advice.note}
            >
              {adviceMeta.label}
            </span>
          )}
          {broadcast.model_error && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/15 text-red-400">
              异常
            </span>
          )}
        </div>
        <span className="text-[10px] font-num text-[var(--text-muted)]">
          {formatBroadcastTime(broadcast.created_at)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {(
          [
            ["进场", broadcast.entry],
            ["止盈", broadcast.take_profit],
            ["止损", broadcast.stop_loss],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="rounded-md bg-[var(--bg-tertiary)] px-2 py-1.5 text-center"
          >
            <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
            <div className="text-xs font-num text-[var(--text-primary)]">
              {priceText(value)}
            </div>
          </div>
        ))}
      </div>

      {levels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {levels.map((level, index) => (
            <span
              key={`${level.price}-${index}`}
              className="px-1.5 py-0.5 rounded border text-[10px] font-num"
              style={{
                color: level.type === "resistance" ? "#fb923c" : "#60a5fa",
                borderColor: level.type === "resistance" ? "#fb923c55" : "#60a5fa55",
              }}
              title={level.label}
            >
              {level.type === "resistance" ? "压" : "支"} {level.price}
              {level.label ? ` ${level.label}` : ""}
            </span>
          ))}
        </div>
      )}

      {advice && advice.note && (
        <div
          className="text-[10px] leading-relaxed"
          style={{ color: adviceMeta?.color ?? "var(--text-secondary)" }}
        >
          持仓建议：{advice.note}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">
        {broadcast.model_error
          ? broadcast.commentary
          : `【${contractName(broadcast.symbol)} · 技术看盘专家】${broadcast.commentary}`}
      </p>
    </div>
  )
}
