"use client"

/**
 * 实盘盈亏日历（数据经业务服务器同步，复用「实盘交易所接入」凭证）
 *
 * 结构自上而下：月度汇总条（盈亏比 / 总盈利 / 总亏损 / 净盈亏）→
 * 日历九宫格（每格当日盈亏，红盈绿亏 CN 口径，底色深浅=当日盈亏强度）→
 * 当月累计盈亏曲线（lightweight-charts）。
 *
 * 数据源：/api/live/daily-pnl（服务器基于 OKX 成交明细聚合，覆盖约 90 天，
 * 复用「实盘交易所接入」凭证，仅 OKX）；月度汇总与曲线在本地按月重算，
 * 聚合缓存仅存本机 localStorage。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  getCredentialsApi,
  getStoredVenue,
  venueName,
  type VenueCredential,
} from "@/lib/live-api"
import {
  CACHE_FRESH_MS,
  loadDailyPnlCache,
  refreshDailyPnl,
  type DailyPnlCache,
} from "@/lib/pnl-calendar"

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "--"
  return Math.abs(v) >= 100000
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 日历格子用的紧凑金额：+1.2万 / -345.6 / +0.0012 */
function fmtCompact(v: number): string {
  const sign = v > 0 ? "+" : ""
  const a = Math.abs(v)
  if (a >= 100000000) return `${sign}${(a / 100000000).toFixed(2)}亿`
  if (a >= 10000) return `${sign}${(a / 10000).toFixed(1)}万`
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(1)}k`
  if (a > 0 && a < 0.01) return `${sign}${a.toFixed(4)}`
  return `${sign}${a.toFixed(2)}`
}

function pnlColor(v: number): string {
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-[var(--text-secondary)]"
}

const pad = (n: number) => String(n).padStart(2, "0")

interface CumPoint {
  time: string
  value: number
  /** 当日净盈亏（tooltip 用） */
  day: number
}

/** Catmull-Rom 插值转三次贝塞尔：转折柔和，不过分振荡 */
function smoothBezierPath(pts: [number, number][]): string {
  if (pts.length < 2) return ""
  let d = `M ${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d
}

/**
 * 当月累计盈亏曲线：自绘 SVG 贝塞尔平滑曲线 + 渐变面积 + 悬停十字提示。
 * 红=月末累计为盈、绿=为亏（CN 口径）；零轴虚线随数据域自适应。
 */
function CumulativeChart({ points }: { points: CumPoint[] }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const H = 176
  const PAD = { l: 6, r: 46, t: 16, b: 20 }
  const n = points.length
  const innerW = Math.max(width - PAD.l - PAD.r, 10)
  const innerH = H - PAD.t - PAD.b

  const values = points.map((p) => p.value)
  let vmin = Math.min(0, ...values)
  let vmax = Math.max(0, ...values)
  if (vmax - vmin < 1e-9) {
    vmin -= 1
    vmax += 1
  } else {
    const padY = (vmax - vmin) * 0.12
    vmin -= padY
    vmax += padY
  }
  const xAt = (i: number) => PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yAt = (v: number) => PAD.t + (1 - (v - vmin) / (vmax - vmin)) * innerH

  const final = points[n - 1]?.value ?? 0
  const color = final >= 0 ? "#ef4444" : "#22c55e"
  const pts: [number, number][] = points.map((p, i) => [xAt(i), yAt(p.value)])
  const linePath = smoothBezierPath(pts)
  const areaPath =
    linePath && n > 1
      ? `${linePath} L ${xAt(n - 1).toFixed(2)},${(PAD.t + innerH).toFixed(2)} L ${xAt(0).toFixed(2)},${(PAD.t + innerH).toFixed(2)} Z`
      : ""

  // y 轴 4 档刻度（含 0 对齐零线）
  const yTicks = [0, 1, 2, 3].map((k) => vmin + ((vmax - vmin) * k) / 3)
  // x 轴约 5 个日期刻度
  const xStep = Math.max(1, Math.ceil(n / 5))
  const xTicks = points.map((_, i) => i).filter((i) => i % xStep === 0 || i === n - 1)
  const zeroY = yAt(0)

  const hoverP = hover != null && points[hover] ? points[hover] : null
  const fmt = (v: number) =>
    `${v > 0 ? "+" : ""}${Math.abs(v) >= 10000 ? (v / 10000).toFixed(2) + "万" : v.toFixed(2)}`

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: H }}>
      <svg
        width={width || "100%"}
        height={H}
        className="block"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left - PAD.l
          const idx = n <= 1 ? 0 : Math.round((x / innerW) * (n - 1))
          setHover(Math.max(0, Math.min(n - 1, idx)))
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="pnl-cum-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 水平网格 + y 轴刻度 */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.l} x2={PAD.l + innerW}
              y1={yAt(t)} y2={yAt(t)}
              stroke="rgba(255,255,255,0.045)" strokeWidth="1"
            />
            <text
              x={PAD.l + innerW + 6} y={yAt(t) + 3.5}
              fill="#6b7280" fontSize="10" className="font-num"
              textAnchor="start"
            >
              {fmt(t)}
            </text>
          </g>
        ))}
        {/* 零轴虚线 */}
        {vmin < 0 && vmax > 0 && (
          <line
            x1={PAD.l} x2={PAD.l + innerW}
            y1={zeroY} y2={zeroY}
            stroke="rgba(148,163,184,0.4)" strokeWidth="1" strokeDasharray="4 4"
          />
        )}
        {/* x 轴日期 */}
        {xTicks.map((i) => (
          <text
            key={i} x={xAt(i)} y={H - 6}
            fill="#6b7280" fontSize="10"
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
          >
            {Number(points[i].time.slice(8))}日
          </text>
        ))}
        {/* 渐变面积 + 贝塞尔曲线 */}
        {areaPath && <path d={areaPath} fill="url(#pnl-cum-fill)" />}
        {linePath && (
          <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
        )}
        {/* 末端点：光晕圈 + 实心点 */}
        {n > 0 && (
          <>
            <circle cx={xAt(n - 1)} cy={yAt(points[n - 1].value)} r="7" fill={color} opacity="0.18" />
            <circle cx={xAt(n - 1)} cy={yAt(points[n - 1].value)} r="3.4" fill={color} />
          </>
        )}
        {/* 悬停十字线 + 高亮点 */}
        {hoverP && hover != null && (
          <g pointerEvents="none">
            <line
              x1={xAt(hover)} x2={xAt(hover)}
              y1={PAD.t} y2={PAD.t + innerH}
              stroke="rgba(148,163,184,0.35)" strokeWidth="1" strokeDasharray="3 3"
            />
            <circle cx={xAt(hover)} cy={yAt(hoverP.value)} r="4.5" fill={color} stroke="#1a1a1e" strokeWidth="2" />
          </g>
        )}
      </svg>
      {/* 悬浮提示：日期 · 当日 · 累计 */}
      {hoverP && hover != null && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/95 px-2 py-1 text-[10px] leading-relaxed shadow-lg whitespace-nowrap"
          style={{
            left: Math.min(Math.max(xAt(hover) - 60, 0), Math.max(width - 130, 0)),
            top: Math.max(yAt(hoverP.value) - 58, 0),
          }}
        >
          <div className="text-[var(--text-muted)]">{hoverP.time.slice(5).replace("-", "月")}日</div>
          <div className="font-num">
            <span className="text-[var(--text-muted)]">当日 </span>
            <span className={hoverP.day > 0 ? "text-up" : hoverP.day < 0 ? "text-down" : "text-[var(--text-secondary)]"}>{fmt(hoverP.day)}</span>
          </div>
          <div className="font-num">
            <span className="text-[var(--text-muted)]">累计 </span>
            <span className={hoverP.value > 0 ? "text-up" : hoverP.value < 0 ? "text-down" : "text-[var(--text-secondary)]"}>{fmt(hoverP.value)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function PnlCalendar(): React.JSX.Element {
  // 跟随当前实盘交易场所（资产/交易页切换后回到工作台即生效）
  const [venue] = useState(() => getStoredVenue())
  const [credential, setCredential] = useState<VenueCredential | null>(null)
  const [credLoaded, setCredLoaded] = useState(false)
  const [cache, setCache] = useState<DailyPnlCache | null>(() => loadDailyPnlCache(getStoredVenue()))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [monthOffset, setMonthOffset] = useState(0)
  const reqSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    getCredentialsApi()
      .then((cs) => {
        if (!cancelled) setCredential(cs.find((c) => c.venue === venue) ?? null)
      })
      .catch(() => {
        if (!cancelled) setCredential(null)
      })
      .finally(() => {
        if (!cancelled) setCredLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [venue])

  const doRefresh = useCallback(async () => {
    const seq = (reqSeq.current += 1)
    setLoading(true)
    setError("")
    try {
      const next = await refreshDailyPnl({ venue })
      if (reqSeq.current === seq) setCache(next)
    } catch (e) {
      if (reqSeq.current === seq) {
        setError(e instanceof Error ? e.message : "同步实盘账单失败")
      }
    } finally {
      if (reqSeq.current === seq) setLoading(false)
    }
  }, [venue])

  useEffect(() => {
    if (!credential) return
    // 服务器日收益统计目前仅 OKX 实现（其他场所返回空结构）
    if (venue !== "okx") return
    const cached = loadDailyPnlCache(venue)
    setCache(cached)
    if (!cached || Date.now() - cached.fetchedAt > CACHE_FRESH_MS) void doRefresh()
  }, [credential, venue, doRefresh])

  /** 月视图：日历格子 + 汇总 + 月内累计序列 */
  const monthView = useMemo(() => {
    const now = new Date()
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
    const year = first.getFullYear()
    const month = first.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const todayKey = dayKeyOf(now)

    type Cell = {
      day: number
      key: string | null
      pnl: number | null
      count: number
      isToday: boolean
      isFuture: boolean
    }
    const leadingBlanks = (first.getDay() + 6) % 7 // 周一开头
    const cells: Cell[] = []
    for (let i = 0; i < leadingBlanks; i += 1) {
      cells.push({ day: 0, key: null, pnl: null, count: 0, isToday: false, isFuture: false })
    }
    let profit = 0
    let loss = 0
    let winDays = 0
    let lossDays = 0
    let tradedDays = 0
    let totalCount = 0
    let maxAbs = 0
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`
      const entry = cache?.days[key]
      const pnl = entry ? entry.pnl : null
      if (entry) {
        tradedDays += 1
        totalCount += entry.count
        if (entry.pnl > 0) {
          profit += entry.pnl
          winDays += 1
        } else if (entry.pnl < 0) {
          loss += entry.pnl
          lossDays += 1
        }
        maxAbs = Math.max(maxAbs, Math.abs(entry.pnl))
      }
      cells.push({
        day,
        key,
        pnl,
        count: entry?.count ?? 0,
        isToday: key === todayKey,
        isFuture: key > todayKey,
      })
    }
    const net = profit + loss
    const ratio = profit > 0 && loss === 0 ? Infinity : profit + loss === 0 ? null : profit / -loss

    const cumulative: { time: string; value: number; day: number }[] = []
    let acc = 0
    const lastDay = monthOffset === 0 ? now.getDate() : daysInMonth
    for (let day = 1; day <= lastDay; day += 1) {
      const dayPnl = cache?.days[`${year}-${pad(month + 1)}-${pad(day)}`]?.pnl ?? 0
      acc += dayPnl
      cumulative.push({ time: `${year}-${pad(month + 1)}-${pad(day)}`, value: acc, day: dayPnl })
    }

    return {
      title: `${year}年${month + 1}月`,
      cells,
      maxAbs,
      summary: { profit, loss, net, ratio, winDays, lossDays, tradedDays, totalCount },
      cumulative,
      hasData: tradedDays > 0,
    }
  }, [cache, monthOffset])

  /** 翻月下限：不早于最早有数据的日期所在月 */
  const canGoPrev = useMemo(() => {
    if (!cache?.earliestDate) return false
    const [ey, em] = cache.earliestDate.split("-").map(Number)
    const target = new Date()
    return new Date(target.getFullYear(), target.getMonth() + monthOffset - 1, 1).getTime() >=
      new Date(ey, em - 1, 1).getTime()
  }, [cache, monthOffset])

  const s = monthView.summary
  const ratioText =
    s.ratio === Infinity ? "∞" : s.ratio == null ? "--" : `${s.ratio.toFixed(2)} : 1`

  const summaryCells = [
    {
      label: "盈亏比",
      value: ratioText,
      valueClass: "text-[var(--text-primary)]",
      sub: s.winDays + s.lossDays > 0 ? `盈利 ${s.winDays} 天 · 亏损 ${s.lossDays} 天` : "本月暂无盈亏记录",
    },
    {
      label: "总盈利",
      value: `+${fmtMoney(s.profit)}`,
      valueClass: "text-up",
      sub: "当月盈利日合计",
    },
    {
      label: "总亏损",
      value: s.loss === 0 ? "0.00" : `-${fmtMoney(-s.loss)}`,
      valueClass: "text-down",
      sub: "当月亏损日合计",
    },
    {
      label: "净盈亏",
      value: `${s.net > 0 ? "+" : ""}${fmtMoney(s.net)}`,
      valueClass: pnlColor(s.net),
      sub: `${monthView.title} · ${venueName(venue)}`,
    },
    {
      label: "交易笔数",
      value: String(s.totalCount),
      valueClass: "text-[var(--text-primary)]",
      sub: `有盈亏记录 ${s.tradedDays} 天`,
    },
  ]

  const coverageText = useMemo(() => {
    if (!cache) return ""
    if (!cache.earliestDate) return "近 90 天无成交记录"
    const [, m, d] = cache.earliestDate.split("-")
    return `覆盖 ${Number(m)}月${Number(d)}日 起（约近 90 天成交明细）`
  }, [cache])

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]/60">
      {/* 工具行：月份切换 + 场所徽章 + 刷新 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="上一月"
            disabled={monthOffset <= -240 || !canGoPrev}
            onClick={() => setMonthOffset((v) => v - 1)}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </Button>
          <span className="text-sm font-semibold min-w-[88px] text-center">
            {monthView.title}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="下一月"
            disabled={monthOffset >= 0}
            onClick={() => setMonthOffset((v) => v + 1)}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          {venueName(venue)}{credential?.demo ? " 模拟盘" : " 实盘"}
        </span>
        {credential?.api_key_masked && (
          <span className="font-num text-[10px] text-[var(--text-muted)]">{credential.api_key_masked}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {cache && (
            <span className="text-[10px] text-[var(--text-muted)] font-num">
              数据截至 {new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!credential || venue !== "okx" || loading}
            onClick={() => void doRefresh()}
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            刷新
          </Button>
        </div>
      </div>

      {/* 未配置凭证 / 加载 / 出错 提示 */}
      {credLoaded && !credential && (
        <div className="mt-3 rounded-lg bg-[var(--bg-tertiary)]/50 px-4 py-6 text-center">
          <p className="text-xs text-[var(--text-secondary)]">
            尚未配置 {venueName(venue)} 实盘凭证。盈亏日历通过业务服务器同步实盘账单，
            请先在「资产 → 实盘交易所接入」配置 API 凭证。
          </p>
          <Link
            href="/assets"
            className="inline-flex items-center h-7 px-3 mt-2 rounded-md text-xs bg-[var(--bg-primary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            去配置实盘凭证
          </Link>
        </div>
      )}
      {credLoaded && credential && venue !== "okx" && (
        <div className="mt-3 rounded-lg bg-[var(--bg-tertiary)]/50 px-4 py-6 text-center text-xs text-[var(--text-secondary)]">
          日收益统计目前仅支持 OKX，当前实盘场所为 {venueName(venue)}。
          切换方法：交易页左上角场所切换，或
          <Link href="/assets" className="text-[var(--accent-info)] mx-1">资产页</Link>
          配置 OKX 凭证。
        </div>
      )}
      {!credLoaded && !cache && (
        <p className="mt-3 text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> 检查实盘凭证配置…
        </p>
      )}
      {loading && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)] font-num">同步实盘账单中…</p>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-2">
          <p className="text-[11px] text-[var(--accent-danger)] break-all">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px]"
            disabled={loading || !credential}
            onClick={() => void doRefresh()}
          >
            重试
          </Button>
        </div>
      )}

      {credential && venue === "okx" && (
        <>
          {/* 汇总条：盈亏比 / 总盈利 / 总亏损 / 净盈亏 / 交易笔数 */}
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-5 gap-2 rounded-lg bg-[var(--bg-tertiary)]/50 px-2 py-3">
            {summaryCells.map((c, i) => (
              <div key={c.label} className={cn("min-w-0 px-1", i > 0 ? "border-l border-[var(--border)]/60 pl-3" : undefined)}>
                <div className="text-[11px] text-[var(--text-muted)]">{c.label}</div>
                <div className={cn("font-num text-lg font-semibold truncate mt-0.5", c.valueClass)}>
                  {c.value}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* 日历九宫格：每格当日盈亏，底色深浅=盈亏强度 */}
          <div className="mt-3 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((w) => (
              <div key={w} className="text-center text-[10px] text-[var(--text-muted)] pb-1">
                {w}
              </div>
            ))}
            {monthView.cells.map((c, i) =>
              c.key ? (
                <div
                  key={c.key}
                  className={cn(
                    "rounded-md border px-1 py-1 min-h-[46px] flex flex-col gap-0.5",
                    c.pnl == null || c.pnl === 0
                      ? "border-[var(--border)]/40 bg-[var(--bg-tertiary)]/30"
                      : "border-transparent",
                    c.isToday && "ring-1 ring-[var(--text-primary)]/50",
                  )}
                  style={
                    c.pnl != null && c.pnl !== 0 && monthView.maxAbs > 0
                      ? {
                          backgroundColor:
                            c.pnl > 0
                              ? `rgba(239,68,68,${(0.08 + 0.24 * Math.min(Math.abs(c.pnl) / monthView.maxAbs, 1)).toFixed(3)})`
                              : `rgba(34,197,94,${(0.08 + 0.24 * Math.min(Math.abs(c.pnl) / monthView.maxAbs, 1)).toFixed(3)})`,
                        }
                      : undefined
                  }
                  title={
                    c.pnl != null
                      ? `${c.key} · ${fmtCompact(c.pnl)} USDT${c.count > 0 ? ` · ${c.count} 笔` : ""}`
                      : c.key
                  }
                >
                  <span className="text-[10px] text-[var(--text-muted)] leading-none">{c.day}</span>
                  {c.pnl != null ? (
                    <span className={cn("font-num text-[11px] font-semibold leading-tight break-all", pnlColor(c.pnl))}>
                      {fmtCompact(c.pnl)}
                    </span>
                  ) : (
                    !c.isFuture && (
                      <span className="text-[10px] text-[var(--text-muted)]/50 leading-none">--</span>
                    )
                  )}
                </div>
              ) : (
                <div key={`blank-${i}`} />
              ),
            )}
          </div>

          {/* 当月累计盈亏曲线 */}
          <div className="mt-3">
            <div className="text-[11px] text-[var(--text-muted)] mb-1">
              当月累计盈亏曲线（{monthView.title}，USDT）
            </div>
            {monthView.hasData && monthView.cumulative.length > 0 ? (
              <CumulativeChart points={monthView.cumulative} />
            ) : (
              <div className="h-[100px] rounded-lg bg-[var(--bg-tertiary)]/30 flex items-center justify-center text-[11px] text-[var(--text-muted)]">
                {cache ? "本月暂无盈亏记录" : "暂无数据"}
              </div>
            )}
          </div>

          <p className="mt-2 text-[10px] text-[var(--text-muted)]">
            口径：OKX 成交明细「平仓盈亏 − 手续费」按自然日聚合（不含资金费）；红=盈、绿=亏。
            统计范围含 AI 任务与手动单；{coverageText}。
            数据经业务服务器同步，月度汇总与曲线在本地计算。
          </p>
        </>
      )}
    </div>
  )
}
