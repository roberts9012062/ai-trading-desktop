"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  getDailyPnlApi,
  getDailyPnlTasksApi,
  type DailyPnlRow,
  type DailyPnlSummary,
  type TaskPnlGroup,
  type TaskPnlTotal,
} from "@/lib/live-api"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** 工作台·收益分析 —— 盈亏比汇总 + 日历九宫格日收益 + 累计盈亏曲线
 *
 * 数据：OKX 成交明细口径（全账户含任务与手动单，北京自然日），
 * 每日收益 = 平仓已实现盈亏 − 手续费。
 */

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"]

function fmtMoney(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "--"
  return Math.abs(v) >= 100000
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toLocaleString("zh-CN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
}

function fmtCompact(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0"
  const abs = Math.abs(v)
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`
  if (abs >= 1) return v.toFixed(1)
  return v.toFixed(2)
}

/** 当月日历网格（周一起始）：42 格，含月前后的补位 */
function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1))
  // 周一=0 … 周日=6
  const lead = (first.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(
      `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    )
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

function CalendarHeat({
  rows,
  year,
  month,
  onPrev,
  onNext,
}: {
  rows: Map<string, DailyPnlRow>
  year: number
  month: number
  onPrev: () => void
  onNext: () => void
}): React.JSX.Element {
  const cells = useMemo(() => monthGrid(year, month), [year, month])
  const maxAbs = useMemo(() => {
    let m = 0
    for (const c of rows.values()) m = Math.max(m, Math.abs(c.net))
    return m || 1
  }, [rows])
  const monthNet = useMemo(() => {
    let sum = 0
    for (const [date, r] of rows) {
      if (date.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`))
        sum += r.net
    }
    return sum
  }, [rows, year, month])
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={onPrev}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
          aria-label="上月"
        >
          ◀
        </button>
        <div className="text-xs">
          <span className="text-[var(--text-secondary)]">
            {year} 年 {month + 1} 月
          </span>
          <span
            className={cn(
              "ml-2 font-num",
              monthNet > 0
                ? "text-up"
                : monthNet < 0
                  ? "text-down"
                  : "text-[var(--text-muted)]"
            )}
          >
            {monthNet > 0 ? "+" : ""}
            {fmtMoney(monthNet)}
          </span>
        </div>
        <button
          onClick={onNext}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
          aria-label="下月"
        >
          ▶
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {WEEK_LABELS.map((w) => (
          <div
            key={w}
            className="text-center text-[10px] text-[var(--text-muted)] pb-1"
          >
            {w}
          </div>
        ))}
        {cells.map((date, i) => {
          if (date === null)
            return <div key={`blank-${i}`} className="h-12" />
          const r = rows.get(date)
          const net = r?.net ?? 0
          const has = !!r && r.trades > 0
          // 红绿底强度按当日 |net| 相对区间最大值分档
          const intensity = has ? Math.min(Math.abs(net) / maxAbs, 1) : 0
          const level = intensity > 0.66 ? 3 : intensity > 0.33 ? 2 : 1
          return (
            <div
              key={date}
              title={
                has
                  ? `${date}　盈亏 ${net > 0 ? "+" : ""}${fmtMoney(net)} U（手续费 ${fmtMoney(r?.fee ?? 0)} · ${r?.trades} 笔成交）`
                  : date
              }
              className={cn(
                "h-12 rounded flex flex-col items-center justify-center border",
                !has && "border-[var(--border)]/50 text-[var(--text-muted)]",
                has && net > 0 && `bg-up/10 border-up/30 text-up`,
                has && net > 0 && level >= 2 && "bg-up/20",
                has && net < 0 && `bg-down/10 border-down/30 text-down`,
                has && net < 0 && level >= 2 && "bg-down/20"
              )}
            >
              <span className="text-[10px] opacity-80">
                {Number(date.slice(-2))}
              </span>
              {has && (
                <span className="text-[10px] font-num leading-tight">
                  {net > 0 ? "+" : ""}
                  {fmtCompact(net)}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 累计盈亏曲线：平滑贝塞尔 + 渐变面积 + 日期刻度 + 悬停数值 */
function CumulativeChart({ rows }: { rows: DailyPnlRow[] }): React.JSX.Element {
  const W = 640
  const H = 168
  const padY = 18
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const { smoothPath, areaPath, zeroY, pts, minV, maxV } = useMemo(() => {
    const vals = rows.map((r) => r.cumulative)
    const min = Math.min(0, ...vals)
    const max = Math.max(0, ...vals)
    const range = max - min || 1
    const x = (i: number) =>
      rows.length > 1 ? (i / (rows.length - 1)) * W : W / 2
    const y = (v: number) => padY + (1 - (v - min) / range) * (H - 2 * padY)
    const P = vals.map((v, i) => ({ x: x(i), y: y(v) }))
    // Catmull-Rom → cubic bezier（平滑曲线）
    let d = `M ${P[0].x.toFixed(1)},${P[0].y.toFixed(1)}`
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)]
      const p1 = P[i]
      const p2 = P[i + 1]
      const p3 = P[Math.min(P.length - 1, i + 2)]
      const c1x = p1.x + (p2.x - p0.x) / 6
      const c1y = p1.y + (p2.y - p0.y) / 6
      const c2x = p2.x - (p3.x - p1.x) / 6
      const c2y = p2.y - (p3.y - p1.y) / 6
      d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
    }
    return {
      smoothPath: d,
      areaPath: `${d} L ${W},${y(min).toFixed(1)} L 0,${y(min).toFixed(1)} Z`,
      zeroY: y(0),
      pts: P,
      minV: min,
      maxV: max,
    }
  }, [rows])

  const last = rows[rows.length - 1]
  const positive = (last?.cumulative ?? 0) >= 0
  const upColor = "var(--accent-up)"
  const downColor = "var(--accent-down)"
  const lineColor = positive ? upColor : downColor
  const gradId = "daily-cum-fill"
  const tickIdx = useMemo(() => {
    const n = rows.length
    if (n < 2) return []
    return [0, Math.round(n * 0.25), Math.round(n * 0.5), Math.round(n * 0.75), n - 1]
  }, [rows])

  const hover = hoverIdx !== null ? rows[hoverIdx] : null
  const hoverPt = hoverIdx !== null ? pts[hoverIdx] : null

  return (
    <div className="relative">
      {/* y 轴上下界标注 */}
      <div className="absolute -top-1 right-0 text-[10px] font-num text-[var(--text-muted)]">
        {fmtCompact(maxV)}
      </div>
      <div
        ref={wrapRef}
        className="relative"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = wrapRef.current?.getBoundingClientRect()
          if (!rect || rows.length < 2) return
          const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
          setHoverIdx(Math.round(ratio * (rows.length - 1)))
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-[168px] block"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {/* 横向网格 */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1="0"
              y1={padY + f * (H - 2 * padY)}
              x2={W}
              y2={padY + f * (H - 2 * padY)}
              stroke="var(--border)"
              strokeOpacity="0.45"
              strokeWidth="1"
            />
          ))}
          {/* 0 轴 */}
          <line
            x1="0"
            y1={zeroY}
            x2={W}
            y2={zeroY}
            stroke="var(--text-muted)"
            strokeOpacity="0.5"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <path d={areaPath} fill={`url(#${gradId})`} />
          <path
            d={smoothPath}
            fill="none"
            stroke={lineColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* 悬停十字与光点 */}
          {hoverPt && (
            <>
              <line
                x1={hoverPt.x}
                y1={padY}
                x2={hoverPt.x}
                y2={H - padY}
                stroke="var(--text-muted)"
                strokeOpacity="0.6"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={hoverPt.x}
                cy={hoverPt.y}
                r="3.5"
                fill={lineColor}
                stroke="var(--background)"
                strokeWidth="1.5"
              />
            </>
          )}
          {!hoverPt && (
            <circle
              cx={pts[pts.length - 1]?.x}
              cy={pts[pts.length - 1]?.y}
              r="3"
              fill={lineColor}
            />
          )}
        </svg>
        {/* 悬停数值卡 */}
        {hover && hoverPt && (
          <div
            className="absolute -translate-x-1/2 pointer-events-none z-10 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[10px] leading-tight shadow-md whitespace-nowrap"
            style={{
              left: `${(hoverPt.x / W) * 100}%`,
              top: 4,
            }}
          >
            <div className="text-[var(--text-muted)]">{hover.date}</div>
            <div className="font-num">
              当日{" "}
              <span className={hover.net > 0 ? "text-up" : hover.net < 0 ? "text-down" : ""}>
                {hover.net > 0 ? "+" : ""}
                {fmtMoney(hover.net)}
              </span>
            </div>
            <div className="font-num text-[var(--text-muted)]">
              手续费 {fmtMoney(hover.fee)}
            </div>
            <div className="font-num text-[var(--text-secondary)]">
              累计{" "}
              <span className={hover.cumulative > 0 ? "text-up" : hover.cumulative < 0 ? "text-down" : ""}>
                {hover.cumulative > 0 ? "+" : ""}
                {fmtMoney(hover.cumulative)}
              </span>
            </div>
          </div>
        )}
      </div>
      {/* x 轴日期刻度 */}
      <div className="flex justify-between text-[10px] font-num text-[var(--text-muted)] mt-0.5">
        {tickIdx.map((i) => (
          <span key={i}>{(rows[i]?.date ?? "").slice(5)}</span>
        ))}
      </div>
    </div>
  )
}

/** 月度收益柱状图：每月净收益（日收益聚合），正负分色 + 悬停明细 */
function MonthlyChart({ rows }: { rows: DailyPnlRow[] }): React.JSX.Element {
  const [hoverM, setHoverM] = useState<string | null>(null)
  const months = useMemo(() => {
    const m = new Map<
      string,
      { net: number; trades: number; days: number; fee: number }
    >()
    for (const r of rows) {
      const key = r.date.slice(0, 7) // YYYY-MM
      const agg = m.get(key) ?? { net: 0, trades: 0, days: 0, fee: 0 }
      agg.net += r.net
      agg.trades += r.trades
      agg.fee += r.fee
      if (r.trades > 0) agg.days += 1
      m.set(key, agg)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [rows])

  const W = 640
  const H = 168
  const padY = 16
  const maxAbs = useMemo(
    () => Math.max(1, ...months.map(([, v]) => Math.abs(v.net))),
    [months]
  )
  const zeroY = padY + (H - 2 * padY) / 2 // 正负对称轴
  const scale = (H - 2 * padY) / 2 / maxAbs
  const barW = months.length > 0 ? Math.min(72, (W / months.length) * 0.52) : 0
  const hover = hoverM !== null ? months.find(([k]) => k === hoverM) : null

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[168px] block">
        <line
          x1="0"
          y1={zeroY}
          x2={W}
          y2={zeroY}
          stroke="var(--text-muted)"
          strokeOpacity="0.5"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        {months.map(([key, v], i) => {
          const cx = (i + 0.5) * (W / months.length)
          const h = Math.max(2, Math.abs(v.net) * scale)
          const y = v.net >= 0 ? zeroY - h : zeroY
          const dim = hoverM !== null && hoverM !== key
          return (
            <g
              key={key}
              onMouseEnter={() => setHoverM(key)}
              onMouseLeave={() => setHoverM(null)}
            >
              <rect
                x={cx - (W / months.length) / 2}
                y={padY}
                width={W / months.length}
                height={H - 2 * padY}
                fill="transparent"
              />
              <rect
                x={cx - barW / 2}
                y={y}
                width={barW}
                height={h}
                rx="3"
                fill={v.net >= 0 ? "var(--accent-up)" : "var(--accent-down)"}
                opacity={dim ? 0.35 : 0.9}
              />
              {/* 柱顶数值 */}
              <text
                x={cx}
                y={v.net >= 0 ? y - 5 : y + h + 11}
                textAnchor="middle"
                fontSize="10"
                fill={v.net >= 0 ? "var(--accent-up)" : "var(--accent-down)"}
                opacity={dim ? 0.5 : 1}
              >
                {v.net > 0 ? "+" : ""}
                {fmtCompact(v.net)}
              </text>
            </g>
          )
        })}
      </svg>
      {/* 月份标签 */}
      <div className="flex mt-0.5">
        {months.map(([key]) => (
          <div
            key={key}
            className="flex-1 text-center text-[10px] font-num text-[var(--text-muted)]"
          >
            {key.slice(2).replace("-", "/")}
          </div>
        ))}
      </div>
      {hover && (
        <div className="absolute left-1/2 -translate-x-1/2 top-0 pointer-events-none z-10 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[10px] leading-tight shadow-md whitespace-nowrap">
          <span className="text-[var(--text-muted)]">{hover[0]}</span>{" "}
          <span
            className={cn(
              "font-num",
              hover[1].net > 0
                ? "text-up"
                : hover[1].net < 0
                  ? "text-down"
                  : ""
            )}
          >
            {hover[1].net > 0 ? "+" : ""}
            {fmtMoney(hover[1].net)} U
          </span>
          <span className="text-[var(--text-muted)]">
            {" "}
            · {hover[1].trades} 笔 · {hover[1].days} 个交易日 · 手续费{" "}
            {fmtMoney(hover[1].fee)}
          </span>
        </div>
      )}
    </div>
  )
}

/** 今日任务明细：任务分组头（小计）+ 逐笔行 */
function TaskGroup({
  group,
}: {
  group: TaskPnlGroup
}): React.JSX.Element {
  const dirLabel = (d: string, off: string) => {
    const side = d === "buy" ? "买" : "卖"
    const o = off === "open" ? "开" : off === "close" ? "平" : ""
    return `${side}${o}`
  }
  return (
    <>
      <tr className="border-b border-[var(--border)] bg-[var(--accent)]/8">
        <td
          colSpan={2}
          className="py-1.5 px-2 font-medium text-[var(--text-primary)]"
        >
          {group.task_name}
          <span className="text-[var(--text-muted)] ml-1">
            {group.symbol?.toUpperCase()}
          </span>
          <span className="text-[var(--text-muted)] ml-2">
            {group.trades.length} 笔
          </span>
        </td>
        <td colSpan={2} className="py-1.5 px-2 text-right font-num text-[11px]">
          <span className="text-[var(--text-muted)]">小计 </span>
          <span className={group.net > 0 ? "text-up" : group.net < 0 ? "text-down" : ""}>
            {group.net > 0 ? "+" : ""}
            {fmtMoney(group.net)}
          </span>
        </td>
        <td
          colSpan={2}
          className="py-1.5 px-2 text-right font-num text-[11px] text-[var(--text-muted)]"
        >
          赚 +{fmtMoney(group.win)} · 亏 {fmtMoney(group.loss)} · 费{" "}
          {fmtMoney(group.fee)}
        </td>
      </tr>
      {group.trades.map((t, i) => (
        <tr
          key={`${group.task_id}-${i}-${t.time}`}
          className="border-b border-[var(--border)]/40"
        >
          <td className="py-1 px-2 text-[var(--text-muted)] font-num whitespace-nowrap">
            {t.time}
          </td>
          <td className="py-1 px-2 whitespace-nowrap">
            <span
              className={cn(
                "mr-1.5",
                t.direction === "buy" ? "text-up" : "text-down"
              )}
            >
              {dirLabel(t.direction, t.offset)}
            </span>
            <span className="text-[var(--text-muted)]">
              {t.symbol?.toUpperCase()}
            </span>
          </td>
          <td className="py-1 px-2 text-right font-num">{t.qty}</td>
          <td className="py-1 px-2 text-right font-num">{t.avg_price}</td>
          <td
            className={cn(
              "py-1 px-2 text-right font-num",
              t.pnl > 0 ? "text-up" : t.pnl < 0 ? "text-down" : "text-[var(--text-muted)]"
            )}
          >
            {t.offset === "close" ? `${t.pnl > 0 ? "+" : ""}${fmtMoney(t.pnl)}` : "—"}
          </td>
          <td className="py-1 px-2 text-right font-num text-[var(--text-muted)]">
            {fmtMoney(t.fee)}
          </td>
        </tr>
      ))}
    </>
  )
}

export function DailyPnlPanel(): React.JSX.Element {
  const [data, setData] = useState<{
    days: DailyPnlRow[]
    summary: DailyPnlSummary | null
  } | null>(null)
  const [error, setError] = useState(false)
  const [chartView, setChartView] = useState<"cum" | "month">("cum")
  const [taskDetail, setTaskDetail] = useState<{
    tasks: TaskPnlGroup[]
    total: TaskPnlTotal | null
  } | null>(null)
  // 当前展示月（北京时区）：浏览器本地月与北京月偶有跨日差，数据键以
  // 后端北京日为准，网格标题用展示月即可
  const [cursor, setCursor] = useState(() => {
    const bj = new Date(Date.now() + 8 * 3600_000)
    return { y: bj.getUTCFullYear(), m: bj.getUTCMonth() }
  })

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await getDailyPnlApi("okx", 90)
        if (alive) {
          setData(res)
          setError(false)
        }
      } catch {
        if (alive) setError(true)
      }
    }
    load()
    const timer = setInterval(load, 60_000) // 60s（后端同款缓存，平仓后准实时可见）
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 今日任务明细（OKX 成交按任务归属）
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await getDailyPnlTasksApi("okx")
        if (alive) setTaskDetail(res)
      } catch {
        /* 失败保持现状 */
      }
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const rowsByDate = useMemo(
    () => new Map((data?.days ?? []).map((r) => [r.date, r])),
    [data]
  )
  // 日历可浏览范围：数据首月末 ~ 北京当前月末
  const range = useMemo(() => {
    const dates = (data?.days ?? []).map((r) => r.date).sort()
    const first = dates[0]
    const bj = new Date(Date.now() + 8 * 3600_000)
    return {
      min: first ? { y: +first.slice(0, 4), m: +first.slice(5, 7) - 1 } : null,
      max: { y: bj.getUTCFullYear(), m: bj.getUTCMonth() },
    }
  }, [data])
  const canPrev =
    range.min !== null &&
    (cursor.y > range.min.y || (cursor.y === range.min.y && cursor.m > range.min.m))
  const canNext = cursor.y < range.max.y || (cursor.y === range.max.y && cursor.m < range.max.m)

  const summary = data?.summary ?? null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">收益分析 · OKX 实账户口径</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            收益数据加载失败（未连接实盘或网络异常）
          </p>
        )}
        {!error && !summary && (
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            加载中…
          </p>
        )}
        {summary && (
          <>
            {/* 盈亏比 + 盈利/亏损汇总 */}
            <div className="grid grid-cols-4 divide-x divide-[var(--border)]">
              <div className="px-1">
                <div className="text-[11px] text-[var(--text-muted)]">
                  盈亏比
                </div>
                <div className="font-num text-lg font-semibold mt-0.5">
                  {summary.profit_ratio !== null
                    ? `${summary.profit_ratio.toFixed(2)} : 1`
                    : summary.net > 0
                      ? "全胜"
                      : "--"}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  交易 {summary.trade_days} 天
                </div>
              </div>
              <div className="px-1">
                <div className="text-[11px] text-[var(--text-muted)]">
                  总盈利
                </div>
                <div className="font-num text-lg font-semibold text-up mt-0.5">
                  +{fmtMoney(summary.total_profit)}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  USDT
                </div>
              </div>
              <div className="px-1">
                <div className="text-[11px] text-[var(--text-muted)]">
                  总亏损
                </div>
                <div className="font-num text-lg font-semibold text-down mt-0.5">
                  {fmtMoney(summary.total_loss)}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  USDT
                </div>
              </div>
              <div className="px-1">
                <div className="text-[11px] text-[var(--text-muted)]">
                  净盈亏
                </div>
                <div
                  className={cn(
                    "font-num text-lg font-semibold mt-0.5",
                    summary.net > 0
                      ? "text-up"
                      : summary.net < 0
                        ? "text-down"
                        : ""
                  )}
                >
                  {summary.net > 0 ? "+" : ""}
                  {fmtMoney(summary.net)}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  近 90 天
                </div>
              </div>
            </div>
            {/* 日历九宫格日收益 */}
            <CalendarHeat
              rows={rowsByDate}
              year={cursor.y}
              month={cursor.m}
              onPrev={() =>
                canPrev &&
                setCursor((c) =>
                  c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }
                )
              }
              onNext={() =>
                canNext &&
                setCursor((c) =>
                  c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }
                )
              }
            />
            {/* 收益曲线：累计 / 月度 切换 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  {(
                    [
                      ["cum", "累计盈亏曲线"],
                      ["month", "每月收益"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setChartView(key)}
                      className={cn(
                        "text-[11px] rounded-full px-2 py-0.5 transition-colors",
                        chartView === key
                          ? "bg-[var(--accent)]/15 text-[var(--text-primary)] font-medium"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {chartView === "cum" && (data?.days?.length ?? 0) > 1 && (
                  <div className="text-xs font-num font-semibold">
                    <span
                      className={
                        (data!.days[data!.days.length - 1].cumulative ?? 0) > 0
                          ? "text-up"
                          : (data!.days[data!.days.length - 1].cumulative ?? 0) < 0
                            ? "text-down"
                            : ""
                      }
                    >
                      {(data!.days[data!.days.length - 1].cumulative ?? 0) > 0
                        ? "+"
                        : ""}
                      {fmtMoney(data!.days[data!.days.length - 1].cumulative ?? 0)}{" "}
                      U
                    </span>
                  </div>
                )}
              </div>
              {chartView === "cum" ? (
                (data?.days?.length ?? 0) > 1 ? (
                  <CumulativeChart rows={data!.days} />
                ) : (
                  <p className="text-xs text-[var(--text-muted)] py-4 text-center">
                    暂无成交数据
                  </p>
                )
              ) : (data?.days?.length ?? 0) > 0 ? (
                <MonthlyChart rows={data!.days} />
              ) : (
                <p className="text-xs text-[var(--text-muted)] py-4 text-center">
                  暂无成交数据
                </p>
              )}
            </div>
            {/* 今日任务明细：逐笔盈亏/手续费 + 任务小计 + 总计 */}
            {taskDetail && taskDetail.tasks.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-[11px] text-[var(--text-muted)]">
                    今日任务明细
                  </div>
                  {taskDetail.total && (
                    <div className="text-[11px] font-num">
                      <span className="text-up">
                        赚 +{fmtMoney(taskDetail.total.win)}
                      </span>
                      <span className="text-[var(--text-muted)]"> · </span>
                      <span className="text-down">
                        亏 {fmtMoney(taskDetail.total.loss)}
                      </span>
                      <span className="text-[var(--text-muted)]"> · </span>
                      <span className="text-[var(--text-muted)]">
                        费 {fmtMoney(taskDetail.total.fee)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto max-h-[320px] rounded-md border border-[var(--border)]">
                  <table className="w-full text-xs">
                    <thead className="text-[var(--text-muted)] sticky top-0 bg-[var(--card)]">
                      <tr className="border-b border-[var(--border)]">
                        <th className="text-left py-1.5 px-2 font-normal">
                          时间
                        </th>
                        <th className="text-left py-1.5 px-2 font-normal">
                          任务 / 方向
                        </th>
                        <th className="text-right py-1.5 px-2 font-normal">
                          数量
                        </th>
                        <th className="text-right py-1.5 px-2 font-normal">
                          均价
                        </th>
                        <th className="text-right py-1.5 px-2 font-normal">
                          盈亏
                        </th>
                        <th className="text-right py-1.5 px-2 font-normal">
                          手续费
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskDetail.tasks.map((g) => (
                        <TaskGroup key={g.task_id ?? "manual"} group={g} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
